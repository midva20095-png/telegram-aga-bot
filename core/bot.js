require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { randomUUID } = require('crypto');

let aiPlugin = null;
try {
    aiPlugin = require('../ai_plugins/google_gemini_plugin');
    console.log('✅ Плагин Google Gemini успешно подключен к ядру');
} catch (e) {
    console.warn('⚠️ Внимание: Плагин ИИ не найден!', e.message);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const userActiveMode = new Map();
const userAwaitingEmail = new Map();
const userProcessingLock = new Set();
const paymentProcessingLock = new Set();
const processedPayments = new Set();
let handlersRegistered = false;

// Глобальный обработчик ошибок Telegram
bot.catch((err, ctx) => {
    console.error(`⚠️ Ошибка в Telegraf для ${ctx?.updateType || 'неизвестного события'}:`, err.message);
});

bot.use(async (ctx, next) => {
    console.log(`🔔 ПОЛУЧЕН ЗАПРОС: ID: ${ctx.from?.id}, Сообщение: ${ctx.message?.text || ctx.callbackQuery?.data || 'медиа/действие'}`);
    return next();
});

const MODEL_COSTS = {
    'flash': 1,
    'flash_25': 1,
    'pro': 3,
    'nanobanana': 5,
    'nanobanana_pro': 8
};

const MODEL_NAMES = {
    'flash': 'Gemini 3.8 Flash ⚡️',
    'flash_25': 'Gemini 2.5 Flash 🚀',
    'pro': 'Gemini 2.5 Pro 🧠',
    'nanobanana': 'Nano Banana 2 (Картинки) 🎨',
    'nanobanana_pro': 'Nano Banana Pro (HQ) 💎'
};

const CREDIT_PACKAGES = {
    'pack_50': { credits: 50, price: 250, title: '50 кредитов' },
    'pack_150': { credits: 150, price: 750, title: '150 кредитов' },
    'pack_500': { credits: 500, price: 2500, title: '500 кредитов' }
};

const MENU_TEXTS = new Set([
    '🤖 Выбрать модель ИИ', '🤖 Модели', '💳 Мой баланс', '💳 Баланс',
    '💰 Пополнить баланс', 'ℹ️ Справка', 'ℹ Справка'
]);

const mainKeyboard = Markup.keyboard([
    ['🤖 Выбрать модель ИИ', '💳 Мой баланс'],
    ['💰 Пополнить баланс', 'ℹ️ Справка']
]).resize();

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
    try {
        const response = await axios.get(`${process.env.GOOGLE_SCRIPT_URL}`, {
            params: { action: 'get', userId },
            timeout: 30000 // Увеличен таймаут до 30 секунд для холодного старта Google Script
        });
        return parseBalance(response.data);
    } catch (error) {
        console.error("❌ Ошибка чтения баланса:", error.message);
        return 0;
    }
}

async function updateUserBalance(userId, amount) {
    try {
        const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
            action: 'update', userId, amount
        }, { timeout: 30000 });
        return parseBalance(response.data);
    } catch (error) {
        console.error("❌ Ошибка обновления баланса:", error.message);
        throw error;
    }
}

async function getTelegramFileBuffer(ctx, fileId) {
    try {
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 30000 });
        return Buffer.from(response.data);
    } catch (e) {
        return null;
    }
}

function getModelSelectionKeyboard(currentMode) {
    const buttons = Object.keys(MODEL_NAMES).map(key => {
        const isSelected = key === currentMode ? '✅ ' : '';
        return [Markup.button.callback(`${isSelected}${MODEL_NAMES[key]} (${MODEL_COSTS[key]} кр.)`, `set_model_${key}`)];
    });
    return Markup.inlineKeyboard(buttons);
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
    for (const part of splitText(text)) await ctx.reply(part, { parse_mode: 'Markdown' });
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
            amount: {
                value: amount.toFixed(2),
                currency: 'RUB'
            },
            confirmation: {
                type: 'redirect',
                return_url: process.env.YOOKASSA_RETURN_URL || 'https://t.me/'
            },
            capture: true,
            description: description,
            metadata: metadata,
            receipt: {
                customer: { email: email },
                items: [
                    {
                        description: description,
                        quantity: '1.00',
                        amount: {
                            value: amount.toFixed(2),
                            currency: 'RUB'
                        },
                        vat_code: Number(process.env.YOOKASSA_VAT_CODE || '1')
                    }
                ]
            }
        }, {
            auth: { username: shopId, password: secretKey },
            headers: { 'Idempotence-Key': randomUUID() },
            timeout: 20000
        });

        return response.data.confirmation.confirmation_url;
    } catch (error) {
        console.error('❌ Ошибка создания платежа в ЮKassa API:', error.response?.data || error.message);
        return null;
    }
}

async function startBot(app) {
    if (handlersRegistered) return;
    handlersRegistered = true;

    // Регистрация хэндлеров бота
    bot.start(async (ctx) => {
        if (!userActiveMode.has(ctx.from.id)) {
            userActiveMode.set(ctx.from.id, 'flash');
        }
        const currentMode = userActiveMode.get(ctx.from.id);
        const balance = await getUserBalance(ctx.from.id);

        await ctx.reply(
            `🤖 *Главное меню бота*\n\n` +
            `💳 Ваш баланс: *${balance} кредитов*\n` +
            `🎯 Текущая модель: *${MODEL_NAMES[currentMode]}*\n\n` +
            `Отправьте текстовый запрос или фото:`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
    });

    bot.command('cancel', async (ctx) => {
        userAwaitingEmail.delete(ctx.from.id);
        await ctx.reply('Ввод email отменён.', mainKeyboard);
    });

    bot.hears(['💳 Мой баланс', '💳 Баланс'], async (ctx) => {
        const balance = await getUserBalance(ctx.from.id);
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
        await ctx.reply(
            `💳 *Баланс:* ${balance} кр.\nМодель: ${MODEL_NAMES[currentMode]}`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💰 Пополнить баланс', 'action_buy_credits')]
                ])
            }
        );
    });

    bot.hears(['🤖 Выбрать модель ИИ', '🤖 Модели'], async (ctx) => {
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
        await ctx.reply(`🤖 *Выберите модель:*`, { parse_mode: 'Markdown', ...getModelSelectionKeyboard(currentMode) });
    });

    const showPackages = async (ctx) => {
        const keyboard = Object.keys(CREDIT_PACKAGES).map(pkgKey => {
            const pkg = CREDIT_PACKAGES[pkgKey];
            return [Markup.button.callback(`💳 ${pkg.title} — ${pkg.price} ₽`, `buy_pkg_${pkgKey}`)];
        });
        await ctx.reply(`💳 *Выберите пакет пополнения:*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(keyboard) });
    };

    bot.hears('💰 Пополнить баланс', async (ctx) => {
        await showPackages(ctx);
    });

    bot.action('action_choose_ai', async (ctx) => {
        await ctx.answerCbQuery();
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
        await ctx.reply(`🤖 *Выберите ИИ-модель:*`, { parse_mode: 'Markdown', ...getModelSelectionKeyboard(currentMode) });
    });

    bot.action(/^set_model_(.+)$/, async (ctx) => {
        const selectedModel = ctx.match[1];
        if (MODEL_NAMES[selectedModel]) {
            userActiveMode.set(ctx.from.id, selectedModel);
            await ctx.answerCbQuery(`Выбрано: ${MODEL_NAMES[selectedModel]}`);
            await ctx.reply(`✅ Модель изменена на *${MODEL_NAMES[selectedModel]}*`, { parse_mode: 'Markdown' });
        }
    });

    bot.action('action_buy_credits', async (ctx) => {
        await ctx.answerCbQuery();
        await showPackages(ctx);
    });

    bot.action(/^buy_pkg_(.+)$/, async (ctx) => {
        const pkgKey = ctx.match[1];
        const pkg = CREDIT_PACKAGES[pkgKey];
        if (!pkg) return ctx.answerCbQuery('⚠️ Пакет не найден');

        await ctx.answerCbQuery();
        userAwaitingEmail.set(ctx.from.id, pkgKey);

        await ctx.reply(
            `✉️ Вы выбрали: *${pkg.title}* (${pkg.price} ₽).\n\n` +
            `Пожалуйста, введите ваш *Email* в ответном сообщении. На него будет отправлен электронный чек после оплаты (или отправьте /cancel для отмены):`,
            { parse_mode: 'Markdown' }
        );
    });

    bot.on('text', async (ctx, next) => {
        const text = ctx.message.text.trim();
        const userId = ctx.from.id;

        if (MENU_TEXTS.has(text) || text.startsWith('/')) {
            return next();
        }

        if (userAwaitingEmail.has(userId)) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(text)) {
                return ctx.reply('⚠️ Кажется, это не похоже на email. Пожалуйста, введите корректный адрес электронной почты (или /cancel для отмены):', { parse_mode: 'Markdown' });
            }

            const pkgKey = userAwaitingEmail.get(userId);
            userAwaitingEmail.delete(userId);
            const pkg = CREDIT_PACKAGES[pkgKey];

            await ctx.reply(`⏳ Генерирую ссылку на оплату для ${text}...`);

            const paymentUrl = await createYookassaPayment(
                pkg.price, 
                `Покупка ${pkg.title} в боте`, 
                text, 
                { userId: String(userId), credits: String(pkg.credits) }
            );

            if (paymentUrl) {
                return ctx.reply(
                    `💳 Ссылка на оплату сформирована успешно!\n\n` +
                    `Электронный чек будет автоматически отправлен на адрес: *${text}*\n\n` +
                    `Нажмите кнопку ниже для перехода к оплате:`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.url('🔗 Оплатить в ЮKassa', paymentUrl)]
                        ])
                    }
                );
            } else {
                return ctx.reply('⚠️ Не удалось сформировать ссылку на оплату. Обратитесь к администратору.');
            }
        }

        return next();
    });

    const handleAiRequest = async (ctx) => {
        const text = ctx.message?.text || '';
        if (MENU_TEXTS.has(text.trim())) return;

        const userId = ctx.from.id;
        if (userAwaitingEmail.has(userId)) return;
        if (userProcessingLock.has(userId)) {
            return ctx.reply('⏳ Подождите, предыдущий запрос ещё обрабатывается.');
        }

        userProcessingLock.add(userId);
        let waitMessage = null;
        let charged = false;

        try {
            const currentMode = userActiveMode.get(userId) || 'flash';
            const cost = MODEL_COSTS[currentMode] || 1;

            const balance = await getUserBalance(userId);
            if (balance < cost) {
                return ctx.reply(
                    `❌ *Недостаточно кредитов!*\nВаш баланс: ${balance} кр. Требуется: ${cost} кр.`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([[Markup.button.callback('💰 Пополнить баланс', 'action_buy_credits')]])
                    }
                );
            }

            if (!aiPlugin || typeof aiPlugin.processRequest !== 'function') {
                return ctx.reply('⚠️ Плагин ИИ временно недоступен.');
            }

            waitMessage = await ctx.reply(`⏳ *Генерирую ответ...*`, { parse_mode: 'Markdown' });

            let prompt = text || ctx.message?.caption || '';
            let fileBuffer = null;
            let mimeType = null;

            if (ctx.message?.photo && ctx.message.photo.length > 0) {
                const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
                fileBuffer = await getTelegramFileBuffer(ctx, largestPhoto.file_id);
                mimeType = 'image/jpeg';
            }

            const rawAiResult = await aiPlugin.processRequest({
                prompt, fileBuffer, mimeType, modelKey: currentMode
            });

            const aiResult = validateAiResult(rawAiResult);

            const remainingBalance = await updateUserBalance(userId, -cost);
            charged = true;

            try { await ctx.deleteMessage(waitMessage.message_id); } catch(e){}
            waitMessage = null;

            const footer = `💳 *Списано:* ${cost} кр. | *Остаток:* ${remainingBalance} кр.`;

            if (aiResult.type === 'image' && aiResult.buffer) {
                const caption = `${aiResult.text || ''}\n\n${footer}`;
                if (caption.length <= 1024) {
                    await ctx.replyWithPhoto({ source: aiResult.buffer }, { caption, parse_mode: 'Markdown' });
                } else {
                    await ctx.replyWithPhoto({ source: aiResult.buffer });
                    await sendPlainText(ctx, caption);
                }
            } else {
                await sendPlainText(ctx, `${aiResult.text}\n\n───────────────\n${footer}`);
            }
        } catch (error) {
            console.error('❌ Ошибка генерации:', error);
            if (waitMessage) {
                try { await ctx.deleteMessage(waitMessage.message_id); } catch(e){}
            }
            await ctx.reply(charged 
                ? '⚠️ Ответ сгенерирован и кредиты списаны, но произошла ошибка при отправке.'
                : `⚠️ Произошла ошибка: ${error.message}`);
        } finally {
            userProcessingLock.delete(userId);
        }
    };

    bot.on('text', handleAiRequest);
    bot.on('photo', handleAiRequest);

    if (app) {
        // Использование Webhook вместо Long Polling (решает проблему 409 Conflict на Render)
        const webhookPath = `/telegram-webhook/${process.env.BOT_TOKEN}`;
        app.use(bot.webhookCallback(webhookPath));

        const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://telegram-aga-bot.onrender.com';
        const fullWebhookUrl = `${externalUrl}${webhookPath}`;

        try {
            await bot.telegram.setWebhook(fullWebhookUrl);
            console.log(`🌐 Telegram вебхук успешно установлен на ${fullWebhookUrl}`);
        } catch (err) {
            console.error('❌ Ошибка установки вебхука:', err.message);
        }
    } else {
        // Fallback на polling, если Express не передан
        try {
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            await bot.launch();
            console.log('🤖 Ядро бота запущено через Long Polling!');
        } catch (err) {
            console.error('⚠️ Ошибка запуска polling:', err.message);
        }
    }

    // Настройка роута ЮKassa
    if (app) {
        app.post('/yookassa-webhook', async (req, res) => {
            let paymentId = null;
            let lockAcquired = false;
            try {
                const event = req.body;
                if (event?.event !== 'payment.succeeded') return res.status(200).send('OK');

                paymentId = event.object?.id;
                if (!paymentId || processedPayments.has(paymentId)) return res.status(200).send('OK');
                if (paymentProcessingLock.has(paymentId)) return res.status(503).send('Retry later');

                paymentProcessingLock.add(paymentId);
                lockAcquired = true;

                const shopId = process.env.YOOKASSA_SHOP_ID;
                const secretKey = process.env.YOOKASSA_SECRET_KEY;
                if (!shopId || !secretKey) return res.status(503).send('Unavailable');

                const response = await axios.get(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
                    auth: { username: shopId, password: secretKey }, timeout: 15000
                });

                const payment = response.data;
                if (payment?.status !== 'succeeded' || payment.paid !== true) {
                    return res.status(400).send('Not confirmed');
                }

                const userId = Number(payment.metadata?.userId);
                const creditsToAdd = Number(payment.metadata?.credits);

                if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(creditsToAdd)) {
                    return res.status(400).send('Invalid metadata');
                }

                const newBalance = await updateUserBalance(userId, creditsToAdd);
                processedPayments.add(paymentId);

                try {
                    await bot.telegram.sendMessage(
                        userId,
                        `🎉 *Оплата успешно получена!*\n\n` +
                        `➕ Начислено: *${creditsToAdd} кредитов*\n` +
                        `💳 Ваш текущий баланс: *${newBalance} кредитов*`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (err) {
                    console.error('❌ Не удалось отправить сообщение в Telegram:', err.message);
                }

                return res.status(200).send('OK');
            } catch (error) {
                console.error('❌ Ошибка вебхука ЮKassa:', error.message);
                return res.status(500).send('Internal Server Error');
            } finally {
                if (lockAcquired && paymentId) paymentProcessingLock.delete(paymentId);
            }
        });
        console.log('🌐 Роут /yookassa-webhook успешно привязан к Express');
    }
}

module.exports = { startBot };
