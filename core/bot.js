require('dotenv').config();

const crypto = require('crypto');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const SHOP_ID = '1120841';
const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL?.trim();
const YOOKASSA_SECRET_KEY = (
    process.env.YOOKASSA_SECRET_KEY ||
    process.env.YUKASSA_SECRET_KEY ||
    ''
).trim();

// Один и тот же секрет укажите в Render и Google Apps Script.
// Он защищает операции записи баланса в таблицу.
const BALANCE_API_SECRET = process.env.BALANCE_API_SECRET?.trim();

if (!BOT_TOKEN) throw new Error('Не задан BOT_TOKEN');
if (!GOOGLE_SCRIPT_URL) throw new Error('Не задан GOOGLE_SCRIPT_URL');
if (!YOOKASSA_SECRET_KEY) throw new Error('Не задан YOOKASSA_SECRET_KEY');
if (!BALANCE_API_SECRET) throw new Error('Не задан BALANCE_API_SECRET');

let aiPlugin = null;
try {
    aiPlugin = require('../ai_plugins/google_gemini_plugin');
    console.log('✅ Gemini-плагин подключён');
} catch (error) {
    console.warn('⚠️ Gemini-плагин не загружен:', error.message);
}

const bot = new Telegraf(BOT_TOKEN);
const userActiveMode = new Map();

const MODEL_COSTS = {
    flash: 1,
    flash_25: 1,
    pro: 3,
    nanobanana: 5,
    nanobanana_pro: 8
};

const MODEL_NAMES = {
    flash: 'Gemini Flash ⚡️',
    flash_25: 'Gemini 2.5 Flash 🚀',
    pro: 'Gemini 2.5 Pro 🧠',
    nanobanana: 'Nano Banana 🎨',
    nanobanana_pro: 'Nano Banana Pro 💎'
};

const CREDIT_PACKAGES = {
    pack_50: { credits: 50, price: 100, title: '50 кредитов' },
    pack_150: { credits: 150, price: 250, title: '150 кредитов' },
    pack_500: { credits: 500, price: 700, title: '500 кредитов' }
};

const mainKeyboard = Markup.keyboard([
    ['🤖 Выбрать модель ИИ', '💳 Мой баланс'],
    ['💰 Пополнить баланс', 'ℹ️ Справка']
]).resize();

const menuTexts = new Set([
    '🤖 Выбрать модель ИИ',
    '🤖 Модели',
    '💳 Мой баланс',
    '💳 Баланс',
    '💰 Пополнить баланс',
    'ℹ️ Справка',
    'ℹ️ Помощь / Справка'
]);

function getModelKeyboard(currentMode) {
    return Markup.inlineKeyboard(
        Object.keys(MODEL_NAMES).map(key => [
            Markup.button.callback(
                `${key === currentMode ? '✅ ' : ''}${MODEL_NAMES[key]} (${MODEL_COSTS[key]} кр.)`,
                `set_model_${key}`
            )
        ])
    );
}

function getPackagesKeyboard() {
    return Markup.inlineKeyboard(
        Object.entries(CREDIT_PACKAGES).map(([key, pkg]) => [
            Markup.button.callback(
                `💳 ${pkg.title} — ${pkg.price} ₽`,
                `buy_pkg_${key}`
            )
        ])
    );
}

function formatAxiosError(error) {
    const data = error.response?.data;

    if (data && typeof data === 'object') {
        return [
            `HTTP ${error.response.status}`,
            data.code,
            data.description,
            data.parameter ? `параметр: ${data.parameter}` : null
        ].filter(Boolean).join(' | ');
    }

    return error.message || String(error);
}

async function scriptRequest(action, fields = {}) {
    try {
        // Apps Script Web App должен быть развёрнут с доступом
        // для внешних запросов. Секрет проверяется внутри doPost.
        const response = await axios.post(
            GOOGLE_SCRIPT_URL,
            {
                action,
                secret: BALANCE_API_SECRET,
                ...fields
            },
            {
                timeout: 20000,
                maxRedirects: 5
            }
        );

        const data = response.data;

        if (!data || typeof data !== 'object' || data.ok !== true) {
            throw new Error(data?.error || 'Некорректный ответ Google Apps Script');
        }

        return data;
    } catch (error) {
        if (error.response) {
            throw new Error(
                `Google Apps Script: HTTP ${error.response.status}; ${
                    typeof error.response.data === 'string'
                        ? error.response.data.slice(0, 200)
                        : JSON.stringify(error.response.data).slice(0, 200)
                }`
            );
        }

        throw error;
    }
}

async function getUserBalance(userId) {
    const result = await scriptRequest('get', {
        userId: String(userId)
    });

    const balance = Number(result.balance);
    if (!Number.isSafeInteger(balance) || balance < 0) {
        throw new Error('Google Apps Script вернул некорректный баланс');
    }

    return balance;
}

async function deductUserBalance(userId, cost, requestId) {
    return scriptRequest('deduct', {
        userId: String(userId),
        amount: cost,
        requestId
    });
}

function yookassaClient() {
    return {
        auth: {
            username: SHOP_ID,
            password: YOOKASSA_SECRET_KEY
        },
        timeout: 20000
    };
}

async function createYookassaPayment(userId, pkgKey) {
    const pkg = CREDIT_PACKAGES[pkgKey];
    if (!pkg) throw new Error('Пакет не найден');

    const returnUrl = (
        process.env.YOOKASSA_RETURN_URL?.trim() ||
        'https://t.me/'
    );

    const payload = {
        amount: {
            value: pkg.price.toFixed(2),
            currency: 'RUB'
        },
        capture: true,
        confirmation: {
            type: 'redirect',
            return_url: returnUrl
        },
        description: `Пополнение ${pkg.credits} кредитов`,
        metadata: {
            userId: String(userId),
            pkgKey,
            credits: String(pkg.credits)
        }
    };

    // Не используйте выдуманный customer@example.com.
    // Если ЮKassa требует чек, настройте отправку чека для вашего
    // магазина и задайте реальные данные покупателя.
    const receiptEmail = process.env.RECEIPT_EMAIL?.trim();

    if (receiptEmail) {
        payload.receipt = {
            customer: { email: receiptEmail },
            items: [{
                description: `Пакет ${pkg.credits} кредитов`,
                quantity: '1.00',
                amount: {
                    value: pkg.price.toFixed(2),
                    currency: 'RUB'
                },
                vat_code: Number(process.env.YOOKASSA_VAT_CODE || '1'),
                payment_mode: 'full_payment',
                payment_subject: 'service'
            }]
        };
    }

    try {
        const response = await axios.post(
            'https://api.yookassa.ru/v3/payments',
            payload,
            {
                ...yookassaClient(),
                headers: {
                    // Для API ЮKassa: именно Idempotence-Key.
                    'Idempotence-Key': crypto.randomUUID(),
                    'Content-Type': 'application/json'
                }
            }
        );

        const paymentId = response.data?.id;
        const confirmationUrl =
            response.data?.confirmation?.confirmation_url;

        if (!paymentId || !confirmationUrl) {
            throw new Error(
                'ЮKassa не вернула ID платежа или ссылку confirmation_url'
            );
        }

        return { paymentId, confirmationUrl };
    } catch (error) {
        throw new Error(`ЮKassa: ${formatAxiosError(error)}`);
    }
}

async function getYookassaPayment(paymentId) {
    try {
        const response = await axios.get(
            `https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`,
            yookassaClient()
        );

        return response.data;
    } catch (error) {
        throw new Error(`ЮKassa: ${formatAxiosError(error)}`);
    }
}

async function getTelegramFileBuffer(ctx, fileId) {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
        timeout: 30000
    });

    return Buffer.from(response.data);
}

async function showBalance(ctx) {
    const balance = await getUserBalance(ctx.from.id);
    const mode = userActiveMode.get(ctx.from.id) || 'flash';

    await ctx.reply(
        `💳 Баланс: ${balance} кр.\n` +
        `🤖 Модель: ${MODEL_NAMES[mode]}\n` +
        `Стоимость запроса: ${MODEL_COSTS[mode]} кр.`,
        Markup.inlineKeyboard([
            [Markup.button.callback('💰 Пополнить', 'action_buy_credits')],
            [Markup.button.callback('🤖 Выбрать модель', 'action_choose_ai')]
        ])
    );
}

async function showModels(ctx) {
    const mode = userActiveMode.get(ctx.from.id) || 'flash';
    await ctx.reply('🤖 Выберите модель:', getModelKeyboard(mode));
}

async function showPackages(ctx) {
    await ctx.reply(
        '💰 Выберите пакет кредитов. Бот создаст индивидуальную ссылку ЮKassa:',
        getPackagesKeyboard()
    );
}

bot.catch((error, ctx) => {
    console.error(
        `❌ Ошибка Telegraf [${ctx?.updateType || 'unknown'}]:`,
        error
    );

    // Не показываем пользователю внутренние сведения и секреты.
    if (ctx?.reply) {
        ctx.reply('⚠️ Ошибка обработки запроса. Попробуйте позже.')
            .catch(() => {});
    }
});

bot.start(async ctx => {
    const balance = await getUserBalance(ctx.from.id);
    const mode = userActiveMode.get(ctx.from.id) || 'flash';

    await ctx.reply(
        `🤖 Бот запущен!\n\n` +
        `💳 Баланс: ${balance} кр.\n` +
        `🎯 Модель: ${MODEL_NAMES[mode]}\n\n` +
        `Выберите действие в меню или отправьте запрос.`,
        mainKeyboard
    );
});

bot.hears(['💳 Мой баланс', '💳 Баланс'], showBalance);
bot.hears(['🤖 Выбрать модель ИИ', '🤖 Модели'], showModels);
bot.hears('💰 Пополнить баланс', showPackages);

bot.hears(['ℹ️ Справка', 'ℹ️ Помощь / Справка'], async ctx => {
    await ctx.reply(
        'Выберите модель, отправьте текст или фото. Для пополнения ' +
        'нажмите «💰 Пополнить баланс», оплатите счёт и затем нажмите ' +
        '«🔄 Проверить оплату».'
    );
});

bot.action('action_choose_ai', async ctx => {
    await ctx.answerCbQuery();
    await showModels(ctx);
});

bot.action('action_buy_credits', async ctx => {
    await ctx.answerCbQuery();
    await showPackages(ctx);
});

bot.action(/^set_model_(.+)$/, async ctx => {
    const mode = ctx.match[1];

    if (!Object.prototype.hasOwnProperty.call(MODEL_NAMES, mode)) {
        return ctx.answerCbQuery('Модель не найдена');
    }

    userActiveMode.set(ctx.from.id, mode);
    await ctx.answerCbQuery('Модель выбрана');
    await ctx.reply(
        `✅ ${MODEL_NAMES[mode]}\nСтоимость: ${MODEL_COSTS[mode]} кр.`
    );
});

bot.action(/^buy_pkg_(.+)$/, async ctx => {
    const pkgKey = ctx.match[1];
    const pkg = CREDIT_PACKAGES[pkgKey];

    if (!pkg) return ctx.answerCbQuery('Пакет не найден');

    await ctx.answerCbQuery('Создаём ссылку на оплату...');

    try {
        const payment = await createYookassaPayment(
            ctx.from.id,
            pkgKey
        );

        await ctx.reply(
            `💳 ${pkg.title} — ${pkg.price} ₽\n\n` +
            'Сначала оплатите счёт, затем нажмите «Проверить оплату».',
            Markup.inlineKeyboard([
                [
                    Markup.button.url(
                        `💳 Оплатить ${pkg.price} ₽`,
                        payment.confirmationUrl
                    )
                ],
                [
                    Markup.button.callback(
                        '🔄 Проверить оплату',
                        `check_${payment.paymentId}`
                    )
                ]
            ])
        );
    } catch (error) {
        console.error('❌ Создание платежа:', error.message);
        await ctx.reply(
            `⚠️ Не удалось создать ссылку:\n${error.message.slice(0, 700)}`
        );
    }
});

bot.action(/^check_(.+)$/, async ctx => {
    const paymentId = ctx.match[1];

    await ctx.answerCbQuery('Проверяем платёж...');

    try {
        // Статус берём напрямую из ЮKassa, а не из данных кнопки.
        const payment = await getYookassaPayment(paymentId);

        if (payment.id !== paymentId) {
            throw new Error('ID платежа не совпадает');
        }

        if (String(payment.metadata?.userId) !== String(ctx.from.id)) {
            return ctx.reply('⛔ Этот платёж принадлежит другому пользователю.');
        }

        const pkgKey = payment.metadata?.pkgKey;
        const pkg = CREDIT_PACKAGES[pkgKey];

        if (!pkg) {
            throw new Error('В платеже указан неизвестный пакет');
        }

        if (
            String(payment.metadata?.credits) !== String(pkg.credits) ||
            payment.amount?.currency !== 'RUB' ||
            payment.amount?.value !== pkg.price.toFixed(2)
        ) {
            throw new Error('Данные платежа не совпадают с пакетом');
        }

        if (payment.status !== 'succeeded' || payment.paid !== true) {
            return ctx.reply(
                `⏳ Оплата пока не подтверждена. Статус: ${
                    payment.status || 'неизвестен'
                }.\nПопробуйте проверить позже.`
            );
        }

        // Скрипт записывает ID платежа в журнал под LockService.
        // Поэтому повторные и одновременные проверки не должны
        // начислять кредиты повторно.
        const result = await scriptRequest('credit_payment', {
            userId: String(ctx.from.id),
            paymentId,
            pkgKey,
            credits: pkg.credits
        });

        if (result.alreadyProcessed) {
            return ctx.reply(
                `✅ Этот платёж уже был зачислен.\n` +
                `💳 Баланс: ${result.balance} кр.`
            );
        }

        await ctx.reply(
            `🎉 Оплата подтверждена!\n` +
            `➕ Начислено: ${pkg.credits} кр.\n` +
            `💳 Баланс: ${result.balance} кр.`
        );
    } catch (error) {
        console.error('❌ Проверка платежа:', error.message);
        await ctx.reply(
            '⚠️ Не удалось завершить проверку платежа. ' +
            'Деньги не пропадут: попробуйте нажать «Проверить оплату» позже.'
        );
    }
});

async function handleAiRequest(ctx) {
    const text = ctx.message?.text || '';

    if (text.startsWith('/') || menuTexts.has(text)) return;

    const userId = ctx.from.id;
    const mode = userActiveMode.get(userId) || 'flash';
    const cost = MODEL_COSTS[mode];
    const prompt = text || ctx.message?.caption || '';

    if (!prompt && !ctx.message?.photo?.length) {
        return ctx.reply('Отправьте текст или фото с подписью.');
    }

    if (!aiPlugin || typeof aiPlugin.processRequest !== 'function') {
        return ctx.reply('⚠️ Gemini-плагин недоступен.');
    }

    const balance = await getUserBalance(userId);

    if (balance < cost) {
        return ctx.reply(
            `❌ Недостаточно кредитов: баланс ${balance} кр., ` +
            `стоимость ${cost} кр.`,
            Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        '💰 Пополнить',
                        'action_buy_credits'
                    )
                ]
            ])
        );
    }

    const waitMessage = await ctx.reply('⏳ Генерирую ответ...');

    try {
        let fileBuffer = null;
        let mimeType = null;

        if (ctx.message?.photo?.length) {
            const photo = ctx.message.photo.at(-1);
            fileBuffer = await getTelegramFileBuffer(
                ctx,
                photo.file_id
            );
            mimeType = 'image/jpeg';
        }

        const aiResult = await aiPlugin.processRequest({
            prompt,
            fileBuffer,
            mimeType,
            modelKey: mode
        });

        if (
            !aiResult ||
            !(
                (aiResult.type === 'image' && aiResult.buffer) ||
                typeof aiResult.text === 'string'
            )
        ) {
            throw new Error('Плагин не вернул результат');
        }

        // Уникальный ID запроса предотвращает повторное списание
        // того же Telegram-сообщения при повторной доставке update.
        const requestId =
            `ai:${ctx.chat.id}:${ctx.message.message_id}`;

        const charge = await deductUserBalance(
            userId,
            cost,
            requestId
        );

        try {
            await ctx.deleteMessage(waitMessage.message_id);
        } catch (_) {}

        const footer =
            `💳 Списано: ${charge.alreadyProcessed ? 0 : cost} кр. ` +
            `| Баланс: ${charge.balance} кр.`;

        if (aiResult.type === 'image' && aiResult.buffer) {
            await ctx.replyWithPhoto(
                { source: aiResult.buffer },
                {
                    caption: (
                        `${aiResult.text || ''}\n\n${footer}`
                    ).slice(0, 1024)
                }
            );
        } else {
            // Без Markdown: ответы модели часто содержат символы,
            // из-за которых Telegram отклоняет сообщение.
            const answer = String(aiResult.text || '');

            for (let offset = 0; offset < answer.length; offset += 3500) {
                await ctx.reply(answer.slice(offset, offset + 3500));
            }

            if (!answer) {
                await ctx.reply('Результат получен.');
            }

            await ctx.reply(footer);
        }
    } catch (error) {
        console.error('❌ Генерация/списание:', error);

        try {
            await ctx.deleteMessage(waitMessage.message_id);
        } catch (_) {}

        await ctx.reply(
            '⚠️ Не удалось завершить запрос. Проверьте баланс и ' +
            'попробуйте позже.'
        );
    }
}

bot.on('text', handleAiRequest);
bot.on('photo', handleAiRequest);

let started = false;

async function startBot() {
    if (started) return;

    // Запускайте только ОДНУ копию бота.
    // Не сбрасываем ожидающие обновления без необходимости.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await bot.launch();

    started = true;
    console.log('✅ Бот запущен через long polling');
}

if (require.main === module) {
    startBot().catch(error => {
        console.error('❌ Не удалось запустить бота:', error);
        process.exit(1);
    });
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = { startBot, getUserBalance };
