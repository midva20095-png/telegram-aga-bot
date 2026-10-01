require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

let aiPlugin = null;
try {
    aiPlugin = require('../ai_plugins/google_gemini_plugin');
    console.log('✅ Плагин Google Gemini успешно подключен к ядру');
} catch (e) {
    console.warn('⚠️ Внимание: Плагин ИИ не найден!');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const userActiveMode = new Map();

// Отладочный логгер
bot.use(async (ctx, next) => {
    console.log(`🔔 ПОЛУЧЕН ЗАПРОС от Telegram! ID: ${ctx.from?.id}, Текст: ${ctx.message?.text || ctx.callbackQuery?.data || (ctx.message?.photo ? 'картинка' : 'другой контент')}`);
    return next();
});

const MODEL_COSTS = {
    'flash': 1,
    'pro': 3,
    'nanobanana': 5,
    'nanobanana_pro': 8
};

const MODEL_NAMES = {
    'flash': 'Gemini 3.8 Flash',
    'pro': 'Gemini 2.5 Pro',
    'nanobanana': 'Nano Banana 2',
    'nanobanana_pro': 'Nano Banana Pro'
};

async function getUserBalance(userId) {
    try {
        console.log(`📤 Запрос баланса для userId=${userId} через Apps Script...`);
        const response = await axios.get(`${process.env.GOOGLE_SCRIPT_URL}?action=get&userId=${userId}`);
        console.log(`📥 Ответ от Apps Script:`, response.data);
        return response.data && response.data.balance !== undefined ? parseInt(response.data.balance) : 0;
    } catch (error) {
        console.error("❌ Ошибка чтения баланса через Google Apps Script:", error.message);
        return 0;
    }
}

async function deductUserBalance(userId, cost) {
    try {
        const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
            action: 'update',
            userId: userId,
            amount: -cost
        });
        return response.data && response.data.balance !== undefined;
    } catch (error) {
        console.error("❌ Ошибка списания через Google Apps Script:", error.message);
        return false;
    }
}

async function startBot() {
    // 1. Сброс старого вебхука для стабильного polling
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🧹 Старый вебхук успешно сброшен, переходим на локальное получение сообщений.');
    } catch (e) {
        console.log('ℹ️ Информация по вебхуку:', e.message);
    }

    // 2. Создание постоянного фиксированного меню
    const persistentMenu = Markup.keyboard([
        ['💳 Проверить баланс', '🤖 Выбрать модель ИИ'],
        ['🛍 Магазин / ЮKassa', '⚙️ Настройки']
    ], {
        columns: 2
    }).resize().persistent();

    // 3. Команда /start
    bot.start(async (ctx) => {
        console.log(`🚀 Сработал обработчик /start для пользователя ${ctx.from.id}`);
        userActiveMode.set(ctx.from.id, 'flash');
        const balance = await getUserBalance(ctx.from.id);
        
        await ctx.reply(
            `🤖 Бот запущен.\n💳 Ваш баланс: *${balance} кредитов*\n\nВыберите нужный инструмент или модель в меню ниже:`,
            {
                parse_mode: 'Markdown',
                ...persistentMenu
            }
        );
    });

    // 4. Обработчики кнопок постоянного меню
    bot.hears('💳 Проверить баланс', async (ctx) => {
        const balance = await getUserBalance(ctx.from.id);
        await ctx.reply(`💳 Ваш текущий баланс: **${balance} кредитов**.`);
    });

    bot.hears('🤖 Выбрать модель ИИ', async (ctx) => {
        const currentMode = userActiveMode.get(ctx.from.id) || 'flash';
        await ctx.reply(`Текущая модель: *${MODEL_NAMES[currentMode]}*\n\nВыберите нужную модель ИИ:`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('⚡ Gemini 3.8 Flash (1 кр.)', 'set_ai_flash')],
                [Markup.button.callback('🧠 Gemini 2.5 Pro (3 кр.)', 'set_ai_pro')],
                [Markup.button.callback('🍌 Nano Banana 2 (5 кр.)', 'set_ai_nanobanana')],
                [Markup.button.callback('👑 Nano Banana Pro (8 кр.)', 'set_ai_nanobanana_pro')]
            ])
        });
    });

    bot.hears('🛍 Магазин / ЮKassa', async (ctx) => {
        await ctx.reply('Пополнение баланса и оплата услуг через ЮKassa:', Markup.inlineKeyboard([
            [Markup.button.callback('💳 Оплатить подписку (100 руб)', 'pay_subscription')]
        ]));
    });

    bot.hears('⚙️ Настройки', async (ctx) => {
        await ctx.reply('⚙️ Меню настроек аккаунта и параметров бота.');
    });

    // 5. Надежный обработчик инлайн-кнопок
    bot.on('callback_query', async (ctx) => {
        const userId = ctx.from.id;
        const callbackData = ctx.callbackQuery.data;
        console.log(`🔔 Инлайн-нажатие от ${userId}, данные: ${callbackData}`);

        try {
            if (callbackData === 'action_balance') {
                const balance = await getUserBalance(userId);
                await ctx.answerCbQuery();
                await ctx.reply(`💳 Ваш текущий баланс: **${balance} кредитов**.`);
            } else if (callbackData === 'action_choose_ai') {
                await ctx.answerCbQuery();
                await ctx.reply('Выберите модель ИИ:', Markup.inlineKeyboard([
                    [Markup.button.callback('⚡ Gemini 3.8 Flash', 'set_ai_flash')],
                    [Markup.button.callback('🧠 Gemini 2.5 Pro', 'set_ai_pro')],
                    [Markup.button.callback('🍌 Nano Banana 2', 'set_ai_nanobanana')],
                    [Markup.button.callback('👑 Nano Banana Pro', 'set_ai_nanobanana_pro')]
                ]));
            } else if (callbackData === 'pay_subscription') {
                await ctx.answerCbQuery('Создаем платеж...');
                await ctx.reply('🔗 Ссылка на оплату через ЮKassa сформирована.');
            } else if (callbackData.startsWith('set_ai_')) {
                const mode = callbackData.replace('set_ai_', '');
                userActiveMode.set(userId, mode);
                await ctx.answerCbQuery(`Модель изменена`);
                await ctx.reply(`✅ Активная модель переключена на: *${MODEL_NAMES[mode] || mode}*`, { parse_mode: 'Markdown' });
            } else {
                await ctx.answerCbQuery('Команда принята');
            }
        } catch (err) {
            console.error('Ошибка в инлайн-обработчике:', err);
            await ctx.answerCbQuery('Произошла ошибка.');
        }
    });

    // 6. Обработка текстовых сообщений
    bot.on('text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) return;
        
        const userId = ctx.from.id;
        const text = ctx.message.text;
        const mode = userActiveMode.get(userId) || 'flash';
        const cost = MODEL_COSTS[mode] || 1;

        console.log(`🤖 Обработка текста для user ${userId} через модель ${mode} (стоимость: ${cost})`);

        const balance = await getUserBalance(userId);
        if (balance < cost) {
            return ctx.reply(`❌ Недостаточно средств на балансе (${balance} кр.). Для запроса через ${MODEL_NAMES[mode]} требуется ${cost} кредитов.`);
        }

        try {
            await ctx.sendChatAction('typing');
            
            let aiResponse = '';
            if (aiPlugin && typeof aiPlugin.generateResponse === 'function') {
                aiResponse = await aiPlugin.generateResponse(text, mode);
            } else {
                aiResponse = `💬 [Эмуляция ${MODEL_NAMES[mode]}]: Получено сообщение "${text}".`;
            }

            await deductUserBalance(userId, cost);
            const remainingBalance = balance - cost;

            await ctx.reply(`${aiResponse}\n\n_📌 Списано: ${cost} кр. Остаток: ${remainingBalance} кр._`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error("❌ Ошибка при обращении к ИИ:", error.message);
            await ctx.reply('⚠️ Произошла ошибка при обращении к модели искусственного интеллекта.');
        }
    });

    // 7. Обработка картинок / фотографий (прием и отправка)
    bot.on('photo', async (ctx) => {
        const userId = ctx.from.id;
        const mode = userActiveMode.get(userId) || 'flash';
        const cost = MODEL_COSTS[mode] || 1;

        console.log(`🖼 Получено фото от user ${userId} через модель ${mode} (стоимость: ${cost})`);

        const balance = await getUserBalance(userId);
        if (balance < cost) {
            return ctx.reply(`❌ Недостаточно средств (${balance} кр.). Для отправки фото через ${MODEL_NAMES[mode]} требуется ${cost} кредитов.`);
        }

        try {
            await ctx.sendChatAction('upload_photo');
            
            const photoArray = ctx.message.photo;
            const photoFile = photoArray[photoArray.length - 1]; // Самое качественное фото
            const fileId = photoFile.file_id;
            const caption = ctx.message.caption || '';

            let aiResponse = '';
            if (aiPlugin && typeof aiPlugin.processImage === 'function') {
                aiResponse = await aiPlugin.processImage(fileId, caption, mode, ctx);
            } else if (aiPlugin && typeof aiPlugin.generateResponse === 'function') {
                aiResponse = await aiPlugin.generateResponse(`[Вложено изображение с подписью: ${caption}]`, mode);
            } else {
                aiResponse = `🖼 [Эмуляция ${MODEL_NAMES[mode]}]: Картинка получена и обработана.`;
            }

            await deductUserBalance(userId, cost);
            const remainingBalance = balance - cost;

            if (typeof aiResponse === 'string') {
                await ctx.reply(`${aiResponse}\n\n_📌 Списано: ${cost} кр. Остаток: ${remainingBalance} кр._`, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error("❌ Ошибка при обработке изображения:", error.message);
            await ctx.reply('⚠️ Произошла ошибка при обработке картинки.');
        }
    });

    // 8. Запуск бота
    await bot.launch();
    console.log('🤖 Ядро бота успешно заведено и слушает сообщения!');
}

module.exports = { startBot };
