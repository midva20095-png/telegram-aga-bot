require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

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

// Глобальный обработчик ошибок Telegram, чтобы сервер не падал при сбоях сети или 409
bot.catch((err, ctx) => {
    console.error(`⚠️ Ошибка в Telegraf для ${ctx?.updateType || 'неизвестного события'}:`, err.message);
});

bot.use(async (ctx, next) => {
    console.log(`🔔 ПОЛУЧЕН ЗАПРОС: ID: ${ctx.from?.id}, Сообщение: ${ctx.message?.text || ctx.callbackQuery?.data || 'медиа/действие'}`);
    return next();
});

// Стоимость генераций в кредитах
const MODEL_COSTS = {
    'flash': 1,
    'flash_25': 1,
    'pro': 3,
    'nanobanana': 5,
    'nanobanana_pro': 8
};

// Текст на кнопках моделей с указанием цен
const MODEL_NAMES = {
    'flash': 'Gemini 3.8 Flash ⚡ (1 кр. / 5 ₽)',
    'flash_25': 'Gemini 2.5 Flash 🚀 (1 кр. / 5 ₽)',
    'pro': 'Gemini 2.5 Pro 🧠 (3 кр. / 15 ₽)',
    'nanobanana': 'Nano Banana 2 🎨 (5 кр. / 25 ₽)',
    'nanobanana_pro': 'Nano Banana Pro 💎 (8 кр. / 40 ₽)'
};

// Пакеты пополнения по курсу 1 кредит = 5 ₽
const CREDIT_PACKAGES = {
    'pack_50': { credits: 50, price: 250, title: '50 кредитов' },
    'pack_100': { credits: 100, price: 500, title: '100 кредитов' },
    'pack_200': { credits: 200, price: 1000, title: '200 кредитов' }
};

const mainKeyboard = Markup.keyboard([
    ['🤖 Выбрать модель ИИ', '💳 Мой баланс'],
    ['💰 Пополнить баланс', 'ℹ️ Справка']
]).resize();

async function getUserBalance(userId) {
    try {
        const response = await axios.get(`${process.env.GOOGLE_SCRIPT_URL}?action=get&userId=${userId}`);
        return response.data && response.data.balance !== undefined ? parseInt(response.data.balance) : 0;
    } catch (error) {
        console.error("❌ Ошибка чтения баланса:", error.message);
        return 0;
    }
}

async function deductUserBalance(userId, cost) {
    try {
        const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
            action: 'deduct',
            userId: userId,
            amount: cost
        });
        return response.data && response.data.success;
    } catch (error) {
        console.error("❌ Ошибка списания баланса:", error.message);
        return false;
    }
}

async function addUserBalance(userId, credits) {
    try {
        const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
            action: 'add',
            userId: userId,
            amount: credits
        });
        return response.data && response.data.balance !== undefined;
    } catch (error) {
        console.error("❌ Ошибка пополнения баланса:", error.message);
        return false;
    }
}

function getModelSelectionKeyboard(currentMode) {
    const buttons = Object.keys(MODEL_NAMES).map(key => {
        const prefix = key === currentMode ? '✅ ' : '';
        return [Markup.button.callback(`${prefix}${MODEL_NAMES[key]}`, `set_model_${key}`)];
    });
    return Markup.inlineKeyboard(buttons);
}

// --- КОМАНДЫ БОТА ---

bot.start(async (ctx) => {
    const balance = await getUserBalance(ctx.from.id);
    await ctx.reply(
        `Привет, ${ctx.from.first_name || 'пользователь'}!\n\n` +
        `🤖 Я твой ИИ-помощник.\n` +
        `💳 Твой текущий баланс: *${balance} кредитов*.\n\n` +
        `Выбери действие в меню ниже:`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

bot.hears(['💳 Мой баланс', '💳 Баланс'], async (ctx) => {
    const balance = await getUserBalance(ctx.from.id);
    const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
    const modelName = MODEL_NAMES[currentMode] || currentMode;

    await ctx.reply(
        `💳 *Ваш баланс:* ${balance} кредитов\n` +
        `🤖 *Активная модель:* ${modelName}\n\n` +
        `1 кредит = 5 ₽`,
        { parse_mode: 'Markdown' }
    );
});

bot.hears(['🤖 Выбрать модель ИИ', '🤖 Модели'], async (ctx) => {
    const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
    await ctx.reply('🤖 *Выберите модель:*', { parse_mode: 'Markdown', ...getModelSelectionKeyboard(currentMode) });
});

bot.hears(['💰 Пополнить баланс'], async (ctx) => {
    const keyboard = Object.keys(CREDIT_PACKAGES).map(pkgKey => {
        const pkg = CREDIT_PACKAGES[pkgKey];
        return [Markup.button.callback(`💳 ${pkg.title} — ${pkg.price} ₽`, `buy_pkg_${pkgKey}`)];
    });

    await ctx.reply(
        `💰 *Пополнение баланса*\n` +
        `💡 *Курс:* 1 кредит = 5 ₽\n\n` +
        `Выберите пакет для покупки:`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(keyboard) }
    );
});

bot.hears(['ℹ️ Справка', 'ℹ Справка'], async (ctx) => {
    const helpText = process.env.HELP_TEXT ||
        `ℹ️ *Справка по боту*\n\n` +
        `• *Курс:* 1 кредит = 5 ₽\n` +
        `• *Как пополнить:* Нажмите «💰 Пополнить баланс»\n` +
        `• *Выбор модели:* Нажмите «🤖 Выбрать модель ИИ»\n\n` +
        `По всем вопросам обращайтесь к администратору.`;

    await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

bot.action('action_choose_ai', async (ctx) => {
    await ctx.answerCbQuery();
    const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
    await ctx.reply('🤖 *Выберите ИИ-модель:*', { parse_mode: 'Markdown', ...getModelSelectionKeyboard(currentMode) });
});

bot.action(/^set_model_(.+)$/, async (ctx) => {
    const selectedModel = ctx.match[1];
    if (MODEL_NAMES[selectedModel]) {
        userActiveMode.set(ctx.from.id, selectedModel);
        await ctx.answerCbQuery(`Выбрано: ${MODEL_NAMES[selectedModel]}`);
        try {
            await ctx.editMessageText(`🤖 *Выбрана модель:* ${MODEL_NAMES[selectedModel]}`, {
                parse_mode: 'Markdown',
                ...getModelSelectionKeyboard(selectedModel)
            });
        } catch (e) {}
    }
});

// --- ПОКУПКА ПАКЕТОВ (ЮKASSA) ---

bot.action(/^buy_pkg_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const pkgKey = ctx.match[1];
    const pkg = CREDIT_PACKAGES[pkgKey];

    if (!pkg) {
        return ctx.reply('⚠️️ Ошибка: Пакет не найден.');
    }

    userAwaitingEmail.set(ctx.from.id, pkgKey);
    await ctx.reply(
        `🛒 *Вы выбрали:* ${pkg.title} (${pkg.price} ₽)\n\n` +
        `📧 Пожалуйста, *напишите ваш Email* в ответном сообщении для отправки чека:`,
        { parse_mode: 'Markdown' }
    );
});

async function startBot(app) {
    if (app) {
        app.post('/yookassa-webhook', async (req, res) => {
            try {
                const event = req.body;
                console.log('🔔 Получен вебхук от ЮKassa:', JSON.stringify(event));

                if (event.event === 'payment.succeeded') {
                    const payment = event.object;
                    const userId = payment.metadata?.userId;
                    const credits = parseInt(payment.metadata?.credits || '0');

                    if (userId && credits > 0) {
                        console.log(`🎉 Платёж подтвержден! Начисляем ${credits} кредитов пользователю ${userId}`);
                        const success = await addUserBalance(userId, credits);
                        if (success) {
                            try {
                                await bot.telegram.sendMessage(
                                    userId,
                                    `🎉 *Оплата прошла успешно!*\n\n` +
                                    `➕ Зачислено: *${credits} кредитов*\n` +
                                    `Спасибо за покупку!`,
                                    { parse_mode: 'Markdown' }
                                );
                                console.log(`✅ Уведомление успешно отправлено пользователю ${userId}`);
                            } catch (err) {
                                console.error(`⚠️ Не удалось отправить сообщение в Telegram пользователю ${userId}:`, err.message);
                            }
                        }
                    }
                }
                res.status(200).send('OK');
            } catch (error) {
                console.error('❌ Ошибка обработки вебхука ЮKassa:', error);
                res.status(500).send('Error');
            }
        });
        console.log('🌐 Роут /yookassa-webhook успешно привязан к Express');
    }

    const handleAiRequest = async (ctx) => {
        const text = ctx.message?.text || '';

        // Пропуск системных кнопок
        if (['🤖 Выбрать модель ИИ', '💳 Мой баланс', '💰 Пополнить баланс', 'ℹ️ Справка', 'ℹ Справка', '🤖 Модели', '💳 Баланс'].includes(text)) {
            return;
        }

        // Обработка ввода Email для оплаты
        if (userAwaitingEmail.has(ctx.from.id)) {
            const email = text.trim();
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            if (!emailRegex.test(email)) {
                return ctx.reply('⚠️ Введен некорректный Email. Попробуйте еще раз:');
            }

            const pkgKey = userAwaitingEmail.get(ctx.from.id);
            const pkg = CREDIT_PACKAGES[pkgKey];
            userAwaitingEmail.delete(ctx.from.id);

            const waitMsg = await ctx.reply('⏳ Формируем ссылку на оплату...');

            try {
                const shopId = process.env.YOOKASSA_SHOP_ID;
                const secretKey = process.env.YOOKASSA_SECRET_KEY;
                const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

                const response = await axios.post(
                    'https://api.yookassa.ru/v3/payments',
                    {
                        amount: { value: `${pkg.price}.00`, currency: 'RUB' },
                        confirmation: { type: 'redirect', return_url: `https://t.me/${ctx.botInfo.username}` },
                        capture: true,
                        description: `Покупка ${pkg.title} в боте`,
                        receipt: {
                            customer: { email: email },
                            items: [
                                {
                                    description: `Пакет ${pkg.title}`,
                                    quantity: '1.00',
                                    amount: { value: `${pkg.price}.00`, currency: 'RUB' },
                                    vat_code: 1
                                }
                            ]
                        },
                        metadata: {
                            userId: ctx.from.id.toString(),
                            credits: pkg.credits.toString()
                        }
                    },
                    {
                        headers: {
                            'Authorization': `Basic ${auth}`,
                            'Idempotence-Key': Date.now().toString(),
                            'Content-Type': 'application/json'
                        }
                    }
                );

                try { await ctx.deleteMessage(waitMsg.message_id); } catch(e){}

                const paymentUrl = response.data.confirmation.confirmation_url;
                await ctx.reply(
                    `💳 *Счет на оплату сформирован*\n\n` +
                    `К оплате: *${pkg.price} ₽*\n` +
                    `Пакет: *${pkg.title}*\n\n` +
                    `Нажмите кнопку ниже для перехода к оплате:`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([[Markup.button.url('💳 Оплатить через ЮKassa', paymentUrl)]])
                    }
                );
            } catch (err) {
                console.error('❌ Ошибка создания платежа ЮKassa:', err.response?.data || err.message);
                try { await ctx.deleteMessage(waitMsg.message_id); } catch(e){}
                await ctx.reply('⚠️ Произошла ошибка при создании платежа. Попробуйте позже.');
            }
            return;
        }

        // Генерация ответа ИИ
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
        const cost = MODEL_COSTS[currentMode] || 1;

        const balance = await getUserBalance(ctx.from.id);
        if (balance < cost) {
            return ctx.reply(
                `⚠️ Недостаточно кредитов!\n\n` +
                `Требуется: *${cost} кр.*\n` +
                `Ваш баланс: *${balance} кр.*\n\n` +
                `Нажмите «💰 Пополнить баланс» для покупки кредитов.`,
                { parse_mode: 'Markdown' }
            );
        }

        const waitMessage = await ctx.reply('🧠 Думаю над ответом...');

        try {
            if (!aiPlugin) throw new Error('Плагин ИИ не подключен');

            const responseText = await aiPlugin.generateResponse(ctx, currentMode);
            await deductUserBalance(ctx.from.id, cost);

            try { await ctx.deleteMessage(waitMessage.message_id); } catch(e){}
            await ctx.reply(responseText, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Ошибка генерации:', error);
            try { await ctx.deleteMessage(waitMessage.message_id); } catch(e){}
            await ctx.reply(`⚠️ Произошла ошибка: ${error.message}`);
        }
    };

    bot.on('text', handleAiRequest);
    bot.on('photo', handleAiRequest);

    // БЕЗОПАСНЫЙ ЗАПУСК БОТА: сбой в Telegram не ломает весь веб-сервер
    bot.launch().then(() => {
        console.log('🤖 Ядро бота успешно запущено!');
    }).catch((err) => {
        console.error('⚠️ Ошибка при запуске Telegram polling (бот перезапустится автоматически):', err.message);
    });
}

module.exports = { startBot };
