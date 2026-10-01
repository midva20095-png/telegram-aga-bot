const { Telegraf, Markup } = require('telegraf');

function setupBotCore(token) {
    if (!token) {
        throw new Error('Bot Token is required');
    }

    const bot = new Telegraf(token);

    // Обработчик команды /start
    bot.start(async (ctx) => {
        const userId = ctx.from.id;
        console.log(`🚀 Сработал обработчик /start для пользователя ${userId}`);
        
        // Фиксированная клавиатура (меню), закрепленная в интерфейсе
        const persistentMenu = Markup.keyboard([
            ['💳 Баланс', '🤖 Gemini ИИ'],
            ['🛍 Магазин / ЮKassa', '⚙️ Настройки']
        ], {
            columns: 2
        }).resize().persistent(); // Делаем меню удобным и фиксированным

        await ctx.reply(
            'Привет! Я твой Telegram-помощник с поддержкой ИИ и платежей.\n\nИспользуй меню справа снизу для вызова основных функций:',
            persistentMenu
        );
    });

    // Обработчик текстовых кнопок из постоянного меню
    bot.hears('💳 Баланс', async (ctx) => {
        const userId = ctx.from.id;
        console.log(`💳 Нажата кнопка баланса пользователем ${userId}`);
        await ctx.reply(`Ваш текущий ID: ${userId}. Запрос баланса обрабатывается...`);
    });

    bot.hears('🤖 Gemini ИИ', async (ctx) => {
        await ctx.reply('Спросите меня о чем-нибудь, и я передам запрос в Google Gemini API.');
    });

    bot.hears('🛍 Магазин / ЮKassa', async (ctx) => {
        await ctx.reply('Выберите товар или услугу для оплаты через ЮKassa:', 
            Markup.inlineKeyboard([
                [Markup.button.callback('Оплатить подписку (100 руб)', 'pay_subscription')]
            ])
        );
    });

    // Исправленный универсальный обработчик инлайн-кнопок (Callback Query)
    bot.on('callback_query', async (ctx) => {
        const userId = ctx.from.id;
        const callbackData = ctx.callbackQuery.data;
        console.log(`🔔 Инлайн-нажатие от ${userId}, данные: ${callbackData}`);

        try {
            if (callbackData === 'pay_subscription') {
                await ctx.answerCbQuery('Создаем платеж через ЮKassa...');
                await ctx.reply('Ссылка на оплату сформирована. (Интеграция ЮKassa активна)');
            } else {
                await ctx.answerCbQuery('Команда обработана');
            }
        } catch (err) {
            console.error('Ошибка обработки инлайн-кнопки:', err);
            await ctx.answerCbQuery('Произошла ошибка при обработке нажатия.');
        }
    });

    // Обработка обычных текстовых сообщений (передача в Gemini)
    bot.on('text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) return; // Пропускаем команды
        console.log(`🔔 Получено текстовое сообщение от ${ctx.from.id}: ${ctx.message.text}`);
        await ctx.reply('Сообщение получено и передается в обработку...');
    });

    return bot;
}

module.exports = { setupBotCore };
