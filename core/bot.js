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
const userAwaitingEmail = new Map(); // Хранит выбранный пакет для пользователей, которые вводят email

// Отладочный логгер
bot.use(async (ctx, next) => {
    console.log(`🔔 ПОЛУЧЕН ЗАПРОС: ID: ${ctx.from?.id}, Сообщение: ${ctx.message?.text || ctx.callbackQuery?.data || 'медиа/действие'}`);
    return next();
});

// Стоимость моделей
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

// Пакеты пополнения
const CREDIT_PACKAGES = {
    'pack_50': { credits: 50, price: 100, title: '50 кредитов' },
    'pack_150': { credits: 150, price: 250, title: '150 кредитов' },
    'pack_500': { credits: 500, price: 700, title: '500 кредитов' }
};

// --- ФИКСИРОВАННАЯ НИЖНЯЯ КЛАВИАТУРА МЕНЮ ---
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
            action: 'update', userId: userId, amount: -cost
        });
        return response.data && response.data.balance !== undefined;
    } catch (error) {
        console.error("❌ Ошибка списания:", error.message);
        return false;
    }
}

async function addUserBalance(userId, amount) {
    try {
        const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
            action: 'update', userId: userId, amount: amount
        });
        return response.data && response.data.balance !== undefined;
    } catch (error) {
        console.error("❌ Ошибка начисления:", error.message);
        return false;
    }
}

async function getTelegramFileBuffer(ctx, fileId) {
    try {
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
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

// Функция создания платежа через ЮKassa API с передачей Email для чека
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
                customer: {
                    email: email
                },
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
            auth: {
                username: shopId,
                password: secretKey
            },
            headers: {
                'Idempotence-Key': `${Date.now()}-${Math.random()}`
            }
        });

        return response.data.confirmation.confirmation_url;
    } catch (error) {
        console.error('❌ Ошибка создания платежа в ЮKassa API:', error.response?.data || error.message);
        return null;
    }
}

async function startBot() {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🧹 Старый вебхук сброшен, запущен Long Polling.');
    } catch (e) {
        console.log('ℹ️ Вебхук:', e.message);
    }

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

    // Кнопка баланса
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

    // Выбор моделей
    bot.hears(['🤖 Выбрать модель ИИ', '🤖 Модели'], async (ctx) => {
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
        await ctx.reply(`🤖 *Выберите модель:*`, { parse_mode: 'Markdown', ...getModelSelectionKeyboard(currentMode) });
    });

    // Пополнение
    bot.hears('💰 Пополнить баланс', async (ctx) => {
        ctx.emit('action_buy_credits_trigger', ctx);
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

    // Показ пакетов при нажатии «Пополнить»
    const showPackages = async (ctx) => {
        const keyboard = Object.keys(CREDIT_PACKAGES).map(pkgKey => {
            const pkg = CREDIT_PACKAGES[pkgKey];
            return [Markup.button.callback(`💳 ${pkg.title} — ${pkg.price} ₽`, `buy_pkg_${pkgKey}`)];
        });
        await ctx.reply(`💳 *Выберите пакет пополнения:*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(keyboard) });
    };

    bot.action('action_buy_credits', async (ctx) => {
        await ctx.answerCbQuery();
        await showPackages(ctx);
    });

    // Шаг 1: Пользователь кликнул на пакет -> просим ввести Email для чека
    bot.action(/^buy_pkg_(.+)$/, async (ctx) => {
        const pkgKey = ctx.match[1];
        const pkg = CREDIT_PACKAGES[pkgKey];
        if (!pkg) return ctx.answerCbQuery('⚠️ Пакет не найден');

        await ctx.answerCbQuery();
        // Сохраняем во временное состояние, какой пакет выбрал пользователь
        userAwaitingEmail.set(ctx.from.id, pkgKey);

        await ctx.reply(
            `✉️ Вы выбрали: *${pkg.title}* (${pkg.price} ₽).\n\n` +
            `Пожалуйста, введите ваш *Email* в ответном сообщении. На него будет отправлен электронный чек после оплаты:`,
            { parse_mode: 'Markdown' }
        );
    });

    // Шаг 2: Обработка введенного Email от пользователя
    bot.on('text', async (ctx, next) => {
        const text = ctx.message.text.trim();
        const userId = ctx.from.id;

        // Проверяем, ожидает ли бот от этого пользователя email для покупки
        if (userAwaitingEmail.has(userId)) {
            // Простейшая проверка на валидность email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(text)) {
                return ctx.reply('⚠️ Кажется, это не похоже на email. Пожалуйста, введите корректный адрес электронной почты (например, `example@mail.ru`):', { parse_mode: 'Markdown' });
            }

            const pkgKey = userAwaitingEmail.get(userId);
            userAwaitingEmail.delete(userId); // Сбрасываем стейт ожидания
            const pkg = CREDIT_PACKAGES[pkgKey];

            await ctx.reply(`⏳ Генерирую ссылку на оплату для ${text}...`);

            // Создаем платеж через ЮKassa API с переданным email
            const paymentUrl = await createYookassaPayment(
                pkg.price, 
                `Покупка ${pkg.title} в боте`, 
                text, 
                { userId: userId, credits: pkg.credits }
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

        // Если это не ввод email, передаем управление дальше (в ИИ-обработчик или меню)
        return next();
    });

    // --- ЕДИНЫЙ ОБРАБОТЧИК ЗАПРОСОВ К ИИ ---
    const handleAiRequest = async (ctx) => {
        const text = ctx.message?.text || '';
        if (['🤖 Выбрать модель ИИ', '💳 Мой баланс', '💰 Пополнить баланс', 'ℹ️ Справка', '🤖 Модели', '💳 Баланс'].includes(text)) {
            return;
        }

        const userId = ctx.from.id;
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

        if (!aiPlugin) return ctx.reply('⚠️ Плагин ИИ временно недоступен.');

        const waitMessage = await ctx.reply(`⏳ *Генерирую ответ...*`, { parse_mode: 'Markdown' });

        try {
            let prompt = text || ctx.message?.caption || '';
            let fileBuffer = null;
            let mimeType = null;

            if (ctx.message?.photo && ctx.message.photo.length > 0) {
                const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
                fileBuffer = await getTelegramFileBuffer(ctx, largestPhoto.file_id);
                mimeType = 'image/jpeg';
            }

            const aiResult = await aiPlugin.processRequest({
                prompt, fileBuffer, mimeType, modelKey: currentMode
            });

            await deductUserBalance(userId, cost);
            const remainingBalance = await getUserBalance(userId);

            try { await ctx.deleteMessage(waitMessage.message_id); } catch(e){}

            if (aiResult.type === 'image' && aiResult.buffer) {
                await ctx.replyWithPhoto({ source: aiResult.buffer }, { caption: `${aiResult.text || ''}\n\n💳 Списано: ${cost} кр. | Остаток: ${remainingBalance} кр.` });
            } else {
                await ctx.reply(`${aiResult.text}\n\n───────────────\n💳 *Списано:* ${cost} кр. | *Остаток:* ${remainingBalance} кр.`, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Ошибка генерации:', error);
            try { await ctx.deleteMessage(waitMessage.message_id); } catch(e){}
            await ctx.reply(`⚠️ Произошла ошибка: ${error.message}`);
        }
    };

    bot.on('text', handleAiRequest);
    bot.on('photo', handleAiRequest);

    await bot.launch();
    console.log('🤖 Ядро бота успешно запущено!');
}

module.exports = { startBot };
