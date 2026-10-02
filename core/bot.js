require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { randomUUID } = require('crypto');

let aiPlugin = null;
try {
    aiPlugin = require('../ai_plugins/google_gemini_plugin');
    console.log('✅ Плагин Google Gemini успешно подключен к ядру');
} catch (error) {
    console.warn('⚠️ Плагин ИИ не найден:', error.message);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const userActiveMode = new Map();
const userAwaitingEmail = new Map();
const userProcessingLock = new Set();
const paymentProcessingLock = new Set();
const processedPayments = new Set();
let handlersRegistered = false;

const MODEL_COSTS = {
    flash: 1, flash_25: 1, pro: 3, nanobanana: 5, nanobanana_pro: 8
};
const MODEL_NAMES = {
    flash: 'Gemini 3.8 Flash ⚡️',
    flash_25: 'Gemini 2.5 Flash 🚀',
    pro: 'Gemini 2.5 Pro 🧠',
    nanobanana: 'Nano Banana 2 (Картинки) 🎨',
    nanobanana_pro: 'Nano Banana Pro (HQ) 💎'
};
const CREDIT_PACKAGES = {
    pack_50: { credits: 50, price: 250, title: '50 кредитов' },
    pack_150: { credits: 150, price: 750, title: '150 кредитов' },
    pack_500: { credits: 500, price: 2500, title: '500 кредитов' }
};
const MENU_TEXTS = new Set([
    '🤖 Выбрать модель ИИ', '🤖 Модели', '💳 Мой баланс', '💳 Баланс',
    '💰 Пополнить баланс', 'ℹ️ Справка', 'ℹ Справка'
]);
const mainKeyboard = Markup.keyboard([
    ['🤖 Выбрать модель ИИ', '💳 Мой баланс'],
    ['💰 Пополнить баланс', 'ℹ️ Справка']
]).resize();

bot.catch((error, ctx) => {
    console.error(`⚠️ Ошибка Telegraf (${ctx?.updateType || 'неизвестно'}):`, error.message);
});
bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim() || '';
    const action = ctx.callbackQuery?.data || '';
    if (ctx.from && (MENU_TEXTS.has(text) || /^\/(start|cancel)(?:@\w+)?(?:\s|$)/i.test(text) ||
        action === 'action_choose_ai' || action === 'action_buy_credits' || action.startsWith('set_model_'))) {
        userAwaitingEmail.delete(ctx.from.id);
    }
    return next();
});

function parseBalance(data) {
    const value = data?.balance;
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
        throw new Error('Сервис баланса вернул некорректный ответ');
    }
    const balance = Number(value);
    if (!Number.isSafeInteger(balance)) {
        throw new Error('Сервис баланса вернул некорректный баланс');
    }
    return balance;
}
async function getUserBalance(userId) {
    const response = await axios.get(process.env.GOOGLE_SCRIPT_URL, {
        params: { action: 'get', userId }, timeout: 20000
    });
    return parseBalance(response.data);
}
async function updateUserBalance(userId, amount) {
    const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
        action: 'update', userId, amount
    }, { timeout: 20000 });
    return parseBalance(response.data);
}
async function getTelegramFileBuffer(ctx, fileId) {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer', timeout: 60000
    });
    const buffer = Buffer.from(response.data);
    if (!buffer.length) throw new Error('Не удалось загрузить фотографию');
    return buffer;
}
function getModelSelectionKeyboard(currentMode) {
    return Markup.inlineKeyboard(Object.keys(MODEL_NAMES).map(key => [
        Markup.button.callback(
            `${key === currentMode ? '✅ ' : ''}${MODEL_NAMES[key]} (${MODEL_COSTS[key]} кр.)`,
            `set_model_${key}`
        )
    ]));
}
function splitText(text, limit = 4000) {
    const parts = [];
    let part = '';
    for (const character of text) {
        if (part.length + character.length > limit) {
            parts.push(part);
            part = '';
        }
        part += character;
    }
    if (part) parts.push(part);
    return parts;
}
async function sendPlainText(ctx, text) {
    for (const part of splitText(text)) await ctx.reply(part);
}
function validateAiResult(result) {
    if (!result || typeof result !== 'object' || result.error || result.success === false ||
        ['error', 'failed', 'failure'].includes(result.status) || result.type === 'error') {
        throw new Error('ИИ не вернул успешный результат');
    }
    const text = typeof result.text === 'string' ? result.text : '';
    if (result.type === 'image') {
        if (!Buffer.isBuffer(result.buffer) || !result.buffer.length) {
            throw new Error('ИИ не вернул изображение');
        }
    } else if (!text.trim()) {
        throw new Error('ИИ вернул пустой ответ');
    }
    return { ...result, text };
}
async function createYookassaPayment(amount, description, email, metadata) {
    try {
        const shopId = process.env.YOOKASSA_SHOP_ID;
        const secretKey = process.env.YOOKASSA_SECRET_KEY;
        if (!shopId || !secretKey) {
            console.warn('⚠️ ЮKassa API ключи не настроены. Используется статический URL.');
            return process.env.YOOKASSA_PAYMENT_URL || null;
        }
        const response = await axios.post('https://api.yookassa.ru/v3/payments', {
            amount: { value: amount.toFixed(2), currency: 'RUB' },
            confirmation: {
                type: 'redirect',
                return_url: process.env.YOOKASSA_RETURN_URL || 'https://t.me/'
            },
            capture: true,
            description,
            metadata,
            receipt: {
                customer: { email },
                items: [{
                    description, quantity: '1.00',
                    amount: { value: amount.toFixed(2), currency: 'RUB' },
                    vat_code: Number(process.env.YOOKASSA_VAT_CODE || '1')
                }]
            }
        }, {
            auth: { username: shopId, password: secretKey },
            headers: { 'Idempotence-Key': randomUUID() },
            timeout: 30000
        });
        return response.data?.confirmation?.confirmation_url || null;
    } catch (error) {
        console.error('❌ Ошибка создания платежа:', error.response?.data || error.message);
        return null;
    }
}
async function showPackages(ctx) {
    const keyboard = Object.entries(CREDIT_PACKAGES).map(([key, pkg]) => [
        Markup.button.callback(`💳 ${pkg.title} — ${pkg.price} ₽`, `buy_pkg_${key}`)
    ]);
    await ctx.reply('💳 Выберите пакет пополнения:', Markup.inlineKeyboard(keyboard));
}

async function startBot(app) {
    if (handlersRegistered) return;
    handlersRegistered = true;

    if (app) {
        app.post('/yookassa-webhook', async (req, res) => {
            let paymentId = null;
            let lockAcquired = false;
            try {
                if (req.body?.event !== 'payment.succeeded') return res.status(200).send('OK');
                paymentId = req.body?.object?.id;
                if (typeof paymentId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(paymentId)) {
                    return res.status(400).send('Invalid payment ID');
                }
                if (processedPayments.has(paymentId)) return res.status(200).send('OK');
                if (paymentProcessingLock.has(paymentId)) return res.status(503).send('Retry later');
                const shopId = process.env.YOOKASSA_SHOP_ID;
                const secretKey = process.env.YOOKASSA_SECRET_KEY;
                if (!shopId || !secretKey) return res.status(503).send('Payment verification unavailable');
                paymentProcessingLock.add(paymentId);
                lockAcquired = true;

                // Проверяем платеж через API, не доверяя metadata и IP из входящего запроса.
                const response = await axios.get(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
                    auth: { username: shopId, password: secretKey }, timeout: 20000
                });
                const payment = response.data;
                if (payment?.id !== paymentId || payment.status !== 'succeeded' || payment.paid !== true) {
                    return res.status(400).send('Payment not confirmed');
                }
                const userId = Number(payment.metadata?.userId);
                const credits = Number(payment.metadata?.credits);
                const pkg = Object.values(CREDIT_PACKAGES).find(item => item.credits === credits);
                if (!Number.isSafeInteger(userId) || userId <= 0 || !pkg ||
                    payment.amount?.currency !== 'RUB' || Number(payment.amount.value) !== pkg.price) {
                    return res.status(400).send('Invalid payment data');
                }
                // Для защиты после перезапуска paymentId нужно атомарно учитывать в хранилище баланса.
                const balance = await updateUserBalance(userId, credits);
                processedPayments.add(paymentId);
                try {
                    await bot.telegram.sendMessage(userId,
                        `🎉 Оплата успешно получена!\n\n➕ Начислено: ${credits} кредитов\n💳 Ваш текущий баланс: ${balance} кредитов`);
                } catch (error) {
                    console.error('❌ Ошибка уведомления об оплате:', error.message);
                }
                return res.status(200).send('OK');
            } catch (error) {
                console.error('❌ Ошибка вебхука ЮKassa:', error.message);
                return res.status(500).send('Internal Server Error');
            } finally {
                if (lockAcquired) paymentProcessingLock.delete(paymentId);
            }
        });
    }

    bot.start(async ctx => {
        if (!userActiveMode.has(ctx.from.id)) userActiveMode.set(ctx.from.id, 'flash');
        const mode = userActiveMode.get(ctx.from.id);
        const balance = await getUserBalance(ctx.from.id);
        await ctx.reply(`🤖 Главное меню бота\n\n💳 Ваш баланс: ${balance} кредитов\n🎯 Текущая модель: ${MODEL_NAMES[mode]}\n\nОтправьте текстовый запрос или фото:`, mainKeyboard);
    });
    bot.command('cancel', async ctx => {
        userAwaitingEmail.delete(ctx.from.id);
        await ctx.reply('Ввод email отменён.', mainKeyboard);
    });
    bot.hears(['💳 Мой баланс', '💳 Баланс'], async ctx => {
        const balance = await getUserBalance(ctx.from.id);
        const mode = userActiveMode.get(ctx.from.id) || 'flash';
        await ctx.reply(`💳 Баланс: ${balance} кр.\nМодель: ${MODEL_NAMES[mode]}`,
            Markup.inlineKeyboard([[Markup.button.callback('💰 Пополнить баланс', 'action_buy_credits')]]));
    });
    bot.hears(['🤖 Выбрать модель ИИ', '🤖 Модели'], async ctx => {
        await ctx.reply('🤖 Выберите модель:', getModelSelectionKeyboard(userActiveMode.get(ctx.from.id) || 'flash'));
    });
    bot.hears('💰 Пополнить баланс', showPackages);
    bot.hears(['ℹ Справка', 'ℹ️ Справка'], async ctx => {
        await ctx.reply('ℹ️ Как пользоваться ботом:\n\n1. Выберите модель ИИ.\n2. Напишите запрос или отправьте картинку.\n3. За успешную генерацию списываются кредиты.\n\nПополнение: «💰 Пополнить баланс».\nОтмена ввода email: /cancel.');
    });
    bot.action('action_choose_ai', async ctx => {
        await ctx.answerCbQuery();
        await ctx.reply('🤖 Выберите ИИ-модель:', getModelSelectionKeyboard(userActiveMode.get(ctx.from.id) || 'flash'));
    });
    bot.action(/^set_model_(.+)$/, async ctx => {
        const mode = ctx.match[1];
        if (!Object.prototype.hasOwnProperty.call(MODEL_NAMES, mode)) return ctx.answerCbQuery('Модель не найдена');
        userActiveMode.set(ctx.from.id, mode);
        await ctx.answerCbQuery(`Выбрано: ${MODEL_NAMES[mode]}`);
        await ctx.reply(`✅ Модель изменена на ${MODEL_NAMES[mode]}`);
    });
    bot.action('action_buy_credits', async ctx => {
        await ctx.answerCbQuery();
        await showPackages(ctx);
    });
    bot.action(/^buy_pkg_(.+)$/, async ctx => {
        const key = ctx.match[1];
        if (!Object.prototype.hasOwnProperty.call(CREDIT_PACKAGES, key)) return ctx.answerCbQuery('⚠️ Пакет не найден');
        const pkg = CREDIT_PACKAGES[key];
        await ctx.answerCbQuery();
        userAwaitingEmail.set(ctx.from.id, key);
        await ctx.reply(`✉️ Вы выбрали: ${pkg.title} (${pkg.price} ₽).\n\nВведите email для электронного чека.\nОтмена: /cancel`);
    });
    bot.on('text', async (ctx, next) => {
        const userId = ctx.from.id;
        if (!userAwaitingEmail.has(userId)) return next();
        const email = ctx.message.text.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return ctx.reply('⚠️ Введите корректный email, например example@mail.ru. Отмена: /cancel');
        }
        if (userProcessingLock.has(userId)) return ctx.reply('⏳ Дождитесь завершения предыдущей операции.');
        userProcessingLock.add(userId);
        try {
            const key = userAwaitingEmail.get(userId);
            const pkg = CREDIT_PACKAGES[key];
            await ctx.reply('⏳ Генерирую ссылку на оплату...');
            const url = await createYookassaPayment(pkg.price, `Покупка ${pkg.title} в боте`, email,
                { userId: String(userId), credits: String(pkg.credits) });
            if (!url) return await ctx.reply('⚠️ Не удалось создать ссылку. Повторите ввод email или нажмите /cancel.');
            await ctx.reply(`💳 Ссылка на оплату сформирована!\n\nEmail для чека: ${email}\n\nНажмите кнопку ниже:`,
                Markup.inlineKeyboard([[Markup.button.url('🔗 Оплатить в ЮKassa', url)]]));
            if (userAwaitingEmail.get(userId) === key) userAwaitingEmail.delete(userId);
        } finally {
            userProcessingLock.delete(userId);
        }
    });

    const handleAiRequest = async ctx => {
        const text = ctx.message?.text || '';
        if (MENU_TEXTS.has(text.trim())) return;
        if (text.startsWith('/')) return ctx.reply('Неизвестная команда. Используйте /start или /cancel.');
        const userId = ctx.from.id;
        if (userAwaitingEmail.has(userId)) return ctx.reply('✉️ Сначала введите email или отмените ввод: /cancel');
        if (userProcessingLock.has(userId)) return ctx.reply('⏳ Дождитесь завершения предыдущей операции.');
        userProcessingLock.add(userId);
        let waitMessage = null;
        let charged = false;
        try {
            const mode = userActiveMode.get(userId) || 'flash';
            const cost = MODEL_COSTS[mode];
            const balance = await getUserBalance(userId);
            if (balance < cost) {
                return await ctx.reply(`❌ Недостаточно кредитов!\nВаш баланс: ${balance} кр. Требуется: ${cost} кр.`,
                    Markup.inlineKeyboard([[Markup.button.callback('💰 Пополнить баланс', 'action_buy_credits')]]));
            }
            if (!aiPlugin || typeof aiPlugin.processRequest !== 'function') {
                return await ctx.reply('⚠️ Плагин ИИ временно недоступен.');
            }
            waitMessage = await ctx.reply('⏳ Генерирую ответ...');
            let fileBuffer = null;
            let mimeType = null;
            const photos = ctx.message?.photo;
            if (photos?.length) {
                fileBuffer = await getTelegramFileBuffer(ctx, photos[photos.length - 1].file_id);
                mimeType = 'image/jpeg';
            }
            const result = validateAiResult(await aiPlugin.processRequest({
                prompt: text || ctx.message?.caption || '', fileBuffer, mimeType, modelKey: mode
            }));
            const remainingBalance = await updateUserBalance(userId, -cost);
            charged = true;
            const footer = `💳 Списано: ${cost} кр. | Остаток: ${remainingBalance} кр.`;
            if (result.type === 'image') {
                const caption = `${result.text}\n\n${footer}`;
                if (caption.length <= 1000) {
                    await ctx.replyWithPhoto({ source: result.buffer }, { caption });
                } else {
                    await ctx.replyWithPhoto({ source: result.buffer });
                    await sendPlainText(ctx, caption);
                }
            } else {
                await sendPlainText(ctx, `${result.text}\n\n───────────────\n${footer}`);
            }
        } catch (error) {
            console.error('❌ Ошибка обработки ИИ-запроса:', error);
            await ctx.reply(charged
                ? '⚠️ Результат сгенерирован и кредиты списаны, но отправка не завершилась. Обратитесь к администратору.'
                : '⚠️ Не удалось завершить запрос. Если баланс изменился, обратитесь к администратору.');
        } finally {
            if (waitMessage) {
                try { await ctx.deleteMessage(waitMessage.message_id); } catch (error) {
                    console.warn('Не удалось удалить сообщение ожидания:', error.message);
                }
            }
            userProcessingLock.delete(userId);
        }
    };
    bot.on('text', handleAiRequest);
    bot.on('photo', handleAiRequest);

    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (error) {
        console.warn('⚠️ Не удалось сбросить вебхук:', error.message);
    }
    bot.launch().catch(error => {
        console.error('⚠️ Ошибка запуска Telegram polling:', error.message);
    });
}

module.exports = { startBot };
