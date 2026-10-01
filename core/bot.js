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

// Отладочный логгер
bot.use(async (ctx, next) => {
    console.log(`🔔 ПОЛУЧЕН ЗАПРОС: ID: ${ctx.from?.id}, Сообщение: ${ctx.message?.text || ctx.callbackQuery?.data || 'медиа/действие'}`);
    return next();
});

// Глобальный перехватчик ошибок Telegraf (защита от падения при 409 Conflict)
bot.catch((err, ctx) => {
    console.error(`⚠️ Ошибка Telegraf [${ctx?.updateType}]:`, err.message || err);
});

// Стоимость моделей в токенах / кредитах
const MODEL_COSTS = {
    'flash': 1,
    'flash_25': 1,
    'pro': 3,
    'nanobanana': 5,
    'nanobanana_pro': 8
};

// Полный перечень моделей для платного API-ключа Google
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

// Чтение баланса из Google Таблицы
async function getUserBalance(userId) {
    try {
        console.log(`📤 Запрос баланса для userId=${userId} из Google Таблицы...`);
        const response = await axios.get(`${process.env.GOOGLE_SCRIPT_URL}?action=get&userId=${userId}`);
        console.log(`📥 Ответ от Google Таблицы:`, response.data);
        return response.data && response.data.balance !== undefined ? parseInt(response.data.balance) : 0;
    } catch (error) {
        console.error("❌ Ошибка чтения баланса из Google Таблицы:", error.message);
        return 0;
    }
}

// Списание токенов из Google Таблицы
async function deductUserBalance(userId, cost) {
    try {
        console.log(`📉 Списание ${cost} токенов у userId=${userId}...`);
        const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
            action: 'update',
            userId: userId,
            amount: -cost
        });
        return response.data && response.data.balance !== undefined;
    } catch (error) {
        console.error("❌ Ошибка списания токенов из Google Таблицы:", error.message);
        return false;
    }
}

// Начисление токенов в Google Таблицу
async function addUserBalance(userId, amount) {
    try {
        console.log(`➕ Пополнение на +${amount} токенов для userId=${userId}...`);
        const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
            action: 'update',
            userId: userId,
            amount: amount
        });
        return response.data && response.data.balance !== undefined;
    } catch (error) {
        console.error("❌ Ошибка начисления токенов в Google Таблицу:", error.message);
        return false;
    }
}

// --- ФУНКЦИИ ЮKASSA (REST API) ---
async function createYookassaPayment(userId, pkgKey) {
    const pkg = CREDIT_PACKAGES[pkgKey];
    if (!pkg) throw new Error('Неверный пакет');

    const shopId = process.env.YUKASSA_SHOP_ID || process.env.YOOKASSA_SHOP_ID || '1120841';
    const secretKey = process.env.YUKASSA_SECRET_KEY || process.env.YOOKASSA_SECRET_KEY;

    if (!secretKey) {
        throw new Error('Не найден YUKASSA_SECRET_KEY / YOOKASSA_SECRET_KEY в Environment Variables');
    }

    const timestamp = Date.now();
    const baseIdempotencyKey = `pay_${userId}_${pkgKey}_${timestamp}`;
    const basicAuth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

    console.log(`📤 Создание платежа в ЮKassa: Shop ID=${shopId}, User=${userId}, Сумма=${pkg.price}₽`);

    const requestPayload = {
        amount: {
            value: `${pkg.price}.00`,
            currency: 'RUB'
        },
        capture: true,
        confirmation: {
            type: 'redirect',
            return_url: 'https://t.me/'
        },
        description: `Пополнение ${pkg.credits} кредитов (ID: ${userId})`,
        metadata: {
            userId: String(userId),
            credits: String(pkg.credits)
        },
        receipt: {
            customer: {
                full_name: `Пользователь ${userId}`,
                email: 'customer@example.com'
            },
            items: [
                {
                    description: `Пакет ${pkg.credits} кредитов`,
                    quantity: '1.00',
                    amount: {
                        value: `${pkg.price}.00`,
                        currency: 'RUB'
                    },
                    vat_code: 1,
                    payment_mode: 'full_payment',
                    payment_subject: 'service'
                }
            ]
        }
    };

    try {
        const response = await axios({
            method: 'post',
            url: 'https://api.yookassa.ru/v3/payments',
            data: requestPayload,
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Idempotency-Key': baseIdempotencyKey,
                'Content-Type': 'application/json'
            }
        });

        if (response.data?.confirmation?.confirmation_url) {
            return {
                confirmationUrl: response.data.confirmation.confirmation_url,
                paymentId: response.data.id
            };
        }
    } catch (err) {
        if (err.response && err.response.status === 400) {
            console.log('⚠️ Ошибка 400 при запросе с чеком. Повторная попытка без блока receipt...');
            delete requestPayload.receipt;
            const retryKey = `${baseIdempotencyKey}_noreceipt`;

            const retryResponse = await axios({
                method: 'post',
                url: 'https://api.yookassa.ru/v3/payments',
                data: requestPayload,
                headers: {
                    'Authorization': `Basic ${basicAuth}`,
                    'Idempotency-Key': retryKey,
                    'Content-Type': 'application/json'
                }
            });

            if (retryResponse.data?.confirmation?.confirmation_url) {
                return {
                    confirmationUrl: retryResponse.data.confirmation.confirmation_url,
                    paymentId: retryResponse.data.id
                };
            }
        }
        throw err;
    }
    throw new Error('ЮKassa не вернула ссылку на оплату');
}

async function checkPaymentStatus(paymentId) {
    const shopId = process.env.YUKASSA_SHOP_ID || process.env.YOOKASSA_SHOP_ID || '1120841';
    const secretKey = process.env.YUKASSA_SECRET_KEY || process.env.YOOKASSA_SECRET_KEY;
    const authString = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

    try {
        const response = await axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
            headers: { 'Authorization': `Basic ${authString}` }
        });
        return response.data;
    } catch (error) {
        console.error('Ошибка проверки статуса платежа:', error.response?.data || error.message);
        return null;
    }
}

// Вспомогательная функция скачивания медиа из Telegram
async function getTelegramFileBuffer(ctx, fileId) {
    try {
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (e) {
        console.error('❌ Ошибка скачивания медиа из Telegram:', e.message);
        return null;
    }
}

// Вспомогательная функция отрисовки инлайн-кнопок выбора моделей
function getModelSelectionKeyboard(currentMode) {
    const buttons = Object.keys(MODEL_NAMES).map(key => {
        const isSelected = key === currentMode ? '✅ ' : '';
        return [Markup.button.callback(`${isSelected}${MODEL_NAMES[key]} (${MODEL_COSTS[key]} кр.)`, `set_model_${key}`)];
    });
    return Markup.inlineKeyboard(buttons);
}

async function startBot() {
    // 1. Сброс вебхука для стабильного Polling
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🧹 Старый вебхук сброшен, запущен Long Polling.');
    } catch (e) {
        console.log('ℹ️ Вебхук:', e.message);
    }

    // --- КОМАНДА /start ---
    bot.start(async (ctx) => {
        console.log(`🚀 /start от пользователя ${ctx.from.id}`);
        if (!userActiveMode.has(ctx.from.id)) {
            userActiveMode.set(ctx.from.id, 'flash');
        }
        const currentMode = userActiveMode.get(ctx.from.id);
        const balance = await getUserBalance(ctx.from.id);

        await ctx.reply(
            `🤖 *Главное меню бота*\n\n` +
            `💳 Ваш баланс: *${balance} кредитов/токенов*\n` +
            `🎯 Текущая модель: *${MODEL_NAMES[currentMode]}*\n\n` +
            `Отправьте текстовый запрос или фото, либо используйте меню ниже для выбора модели и пополнения:`,
            {
                parse_mode: 'Markdown',
                ...mainKeyboard
            }
        );
    });

    // --- ОБРАБОТЧИКИ КНОПОК НИЖНЕГО МЕНЮ ---

    // Кнопка "💳 Мой баланс"
    bot.hears(['💳 Мой баланс', '💳 Баланс'], async (ctx) => {
        const balance = await getUserBalance(ctx.from.id);
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';

        await ctx.reply(
            `💳 *Информация о балансе:*\n\n` +
            `• Доступно токенов: *${balance} кр.*\n` +
            `• Текущая модель: *${MODEL_NAMES[currentMode]}*\n` +
            `• Стоимость 1 генерации: *${MODEL_COSTS[currentMode]} кр.*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💰 Пополнить баланс', 'action_buy_credits')],
                    [Markup.button.callback('🤖 Изменить модель', 'action_choose_ai')]
                ])
            }
        );
    });

    // Кнопка "🤖 Выбрать модель ИИ"
    bot.hears(['🤖 Выбрать модель ИИ', '🤖 Модели'], async (ctx) => {
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
        await ctx.reply(
            `🤖 *Выберите модель ИИ от Google:*\n\n` +
            `• *Gemini 3.8 Flash* — быстрая текстовая модель (1 кр.)\n` +
            `• *Gemini 2.5 Flash* — легкая мультимодальная модель (1 кр.)\n` +
            `• *Gemini 2.5 Pro* — глубокий анализ и сложные задачи (3 кр.)\n` +
            `• *Nano Banana 2* — генерация и редактирование изображений (5 кр.)\n` +
            `• *Nano Banana Pro* — ультра-качественная графика (8 кр.)`,
            {
                parse_mode: 'Markdown',
                ...getModelSelectionKeyboard(currentMode)
            }
        );
    });

    // Кнопка "💰 Пополнить баланс"
    bot.hears('💰 Пополнить баланс', async (ctx) => {
        const directPaymentUrl = process.env.YOOKASSA_PAYMENT_URL || process.env.PAYMENT_URL;

        let replyMarkup;
        if (directPaymentUrl) {
            replyMarkup = Markup.inlineKeyboard([
                [Markup.button.url('💳 Перейти к оплате в ЮKassa ↗️', directPaymentUrl)],
                [Markup.button.callback('💳 Выбрать пакет кредитов', 'action_buy_credits')]
            ]);
        } else {
            const keyboard = Object.keys(CREDIT_PACKAGES).map(pkgKey => {
                const pkg = CREDIT_PACKAGES[pkgKey];
                return [Markup.button.callback(`💳 ${pkg.title} — ${pkg.price} ₽`, `buy_pkg_${pkgKey}`)];
            });
            replyMarkup = Markup.inlineKeyboard(keyboard);
        }

        await ctx.reply(
            `💰 *Пополнение баланса (ЮKassa)*\n\n` +
            `Магазин №: *1120841*\n` +
            `Выберите желаемый способ пополнения или пакет кредитов:`,
            {
                parse_mode: 'Markdown',
                ...replyMarkup
            }
        );
    });

    // Кнопка "ℹ️ Справка"
    bot.hears(['ℹ️ Справка', 'ℹ️ Помощь / Справка', 'ℹ Справка'], async (ctx) => {
        await ctx.reply(
            `ℹ️ *Как пользоваться ботом:*\n\n` +
            `1. Выберите нужную ИИ-модель в меню "🤖 Выбрать модель ИИ".\n` +
            `2. Напишите текст или отправьте картинку с подписью.\n` +
            `3. Бот обработает запрос, выдаст ответ и автоматически спишет стоимость из Google Таблицы.\n` +
            `4. Пополнить баланс можно в любое время по кнопке "💰 Пополнить баланс".`,
            { parse_mode: 'Markdown' }
        );
    });

    // --- INLINE ACTION HANDLERS ---

    // Вызов инлайн-меню моделей
    bot.action('action_choose_ai', async (ctx) => {
        await ctx.answerCbQuery();
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
        await ctx.reply(
            `🤖 *Выберите ИИ-модель:*`,
            {
                parse_mode: 'Markdown',
                ...getModelSelectionKeyboard(currentMode)
            }
        );
    });

    // Переключение модели по клику
    bot.action(/^set_model_(.+)$/, async (ctx) => {
        const selectedModel = ctx.match[1];
        if (MODEL_NAMES[selectedModel]) {
            userActiveMode.set(ctx.from.id, selectedModel);
            await ctx.answerCbQuery(`Выбрано: ${MODEL_NAMES[selectedModel]}`);
            await ctx.reply(
                `✅ Активная модель изменена на *${MODEL_NAMES[selectedModel]}*!\n` +
                `💵 Стоимость генерации: *${MODEL_COSTS[selectedModel]} кр.*`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.answerCbQuery('⚠️ Модель не найдена');
        }
    });

    // Показ пакетов оплаты
    bot.action('action_buy_credits', async (ctx) => {
        await ctx.answerCbQuery();
        const directPaymentUrl = process.env.YOOKASSA_PAYMENT_URL || process.env.PAYMENT_URL;

        const keyboard = Object.keys(CREDIT_PACKAGES).map(pkgKey => {
            const pkg = CREDIT_PACKAGES[pkgKey];
            return [Markup.button.callback(`💳 ${pkg.title} — ${pkg.price} ₽`, `buy_pkg_${pkgKey}`)];
        });

        if (directPaymentUrl) {
            keyboard.unshift([Markup.button.url('🔗 Прямая ссылка на ЮKassa', directPaymentUrl)]);
        }

        await ctx.reply(
            `💳 *Выберите пакет пополнения через ЮKassa:*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(keyboard)
            }
        );
    });

    // Генерация ссылки на оплату через API ЮKassa по клику на пакет (с кнопкой проверки)
    bot.action(/^buy_pkg_(.+)$/, async (ctx) => {
        const pkgKey = ctx.match[1];
        const pkg = CREDIT_PACKAGES[pkgKey];

        if (!pkg) {
            return ctx.answerCbQuery('⚠️ Пакет не найден');
        }

        await ctx.answerCbQuery('⏳ Формируем ссылку на оплату...');

        try {
            const payment = await createYookassaPayment(ctx.from.id, pkgKey);

            await ctx.reply(
                `💳 *Счёт на оплату сформирован!*\n\n` +
                `• Товар: *${pkg.title}*\n` +
                `• Сумма к оплате: *${pkg.price} ₽*\n\n` +
                `Нажмите на кнопку ниже для перехода к оплате, а после завершения нажмите «🔄 Проверить оплату»:`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.url(`💳 Оплатить ${pkg.price} ₽ в ЮKassa ↗️️`, payment.confirmationUrl)],
                        [Markup.button.callback(`🔄 Проверить оплату`, `check_${payment.paymentId}`)]
                    ])
                }
            );
        } catch (error) {
            const yookassaErr = error.response?.data;
            console.error('❌ Ошибка ЮKassa (детали):', yookassaErr || error.message);
            const detailMsg = yookassaErr?.description || error.message;
            await ctx.reply(`⚠️ Не удалось сформировать ссылку на оплату в ЮKassa: ${detailMsg}`);
        }
    });

    // Проверка статуса платежа по кнопке
    bot.action(/^check_(.+)$/, async (ctx) => {
        const paymentId = ctx.match[1];
        await ctx.answerCbQuery('Проверяем статус платежа...');

        const paymentInfo = await checkPaymentStatus(paymentId);
        if (!paymentInfo) {
            return ctx.reply('❌ Не удалось связаться с ЮKassa. Попробуйте позже.');
        }

        if (paymentInfo.status === 'succeeded') {
            const credits = parseInt(paymentInfo.metadata?.credits) || 0;
            const amountPaid = paymentInfo.amount?.value || '';

            await addUserBalance(ctx.from.id, credits);
            const newBalance = await getUserBalance(ctx.from.id);

            try {
                await ctx.editMessageText(
                    `✅ *Платеж успешно подтвержден!*\n\n` +
                    `💵 Сумма: ${amountPaid} руб.\n` +
                    `🪙 Начислено кредитов: ${credits}\n` +
                    `💰 Ваш новый баланс: ${newBalance} кредитов`,
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {
                // Игнорируем если текст сообщения не изменился
            }

            return ctx.reply(
                `🎉 Баланс успешно пополнен на *${credits} кредитов*!\n` +
                `💳 Текущий баланс: *${newBalance} кредитов*`,
                { parse_mode: 'Markdown' }
            );
        } else {
            return ctx.reply(
                `❌ Платеж еще не подтвержден (статус: *${paymentInfo.status}*).\n` +
                `Если вы уже оплатили, подождите пару секунд и нажмите кнопку «🔄 Проверить оплату» снова.`,
                { parse_mode: 'Markdown' }
            );
        }
    });

    // --- ЕДИНЫЙ ОБРАБОТЧИК ЗАПРОСОВ К ИИ (ТЕКСТ И МЕДИА) ---
    const handleAiRequest = async (ctx) => {
        const text = ctx.message?.text || '';
        if (['🤖 Выбрать модель ИИ', '💳 Мой баланс', '💰 Пополнить баланс', 'ℹ️ Справка', '🤖 Модели', '💳 Баланс', 'ℹ️️ Помощь / Справка', 'ℹ Справка'].includes(text)) {
            return;
        }

        const userId = ctx.from.id;
        const currentMode = userActiveMode.get(userId) || 'flash';
        const cost = MODEL_COSTS[currentMode] || 1;

        console.log(`📩 Новая генерация от userId=${userId}. Модель: ${currentMode}, стоимость: ${cost}`);

        const balance = await getUserBalance(userId);
        if (balance < cost) {
            return ctx.reply(
                `❌ *Недостаточно кредитов!*\n\n` +
                `• Ваш баланс: *${balance} кр.*\n` +
                `• Стоимость запроса для *${MODEL_NAMES[currentMode]}*: *${cost} кр.*\n\n` +
                `Пополните баланс для продолжения:`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('💰 Пополнить баланс', 'action_buy_credits')]
                    ])
                }
            );
        }

        if (!aiPlugin) {
            return ctx.reply('⚠️ Плагин ИИ временно недоступен.');
        }

        const waitMessage = await ctx.reply(`⏳ *Генерирую ответ (${MODEL_NAMES[currentMode]})...*`, { parse_mode: 'Markdown' });

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
                prompt: prompt,
                fileBuffer: fileBuffer,
                mimeType: mimeType,
                modelKey: currentMode
            });

            await deductUserBalance(userId, cost);
            const remainingBalance = await getUserBalance(userId);

            try { await ctx.deleteMessage(waitMessage.message_id); } catch(e){}

            if (aiResult.type === 'image' && aiResult.buffer) {
                await ctx.replyWithPhoto(
                    { source: aiResult.buffer },
                    { caption: `${aiResult.text || ''}\n\n💳 Списано: ${cost} кр. | Остаток: ${remainingBalance} кр.` }
                );
            } else {
                await ctx.reply(
                    `${aiResult.text}\n\n───────────────\n💳 *Списано:* ${cost} кр. | *Остаток:* ${remainingBalance} кр.`,
                    { parse_mode: 'Markdown' }
                );
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

module.exports = { startBot, addUserBalance, getUserBalance };
