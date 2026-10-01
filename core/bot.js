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
    console.log(`🔔 ПОЛУЧЕН ЗАПРОС от Telegram! ID: ${ctx.from?.id}, Текст: ${ctx.message?.text || 'нажатие кнопки'}`);
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
    // 1. Сначала принудительно сбрасываем вебхук на стороне Telegram
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🧹 Старый вебхук успешно сброшен, переходим на локальное получение сообщений.');
    } catch (e) {
        console.log('ℹ️ Информация по вебхуку:', e.message);
    }

    // 2. Регистрируем обработчики
    bot.start(async (ctx) => {
        console.log(`🚀 Сработал обработчик /start для пользователя ${ctx.from.id}`);
        userActiveMode.set(ctx.from.id, 'flash');
        const balance = await getUserBalance(ctx.from.id);
        await ctx.reply(
            `🤖 Бот запущен.\n💳 Ваш баланс: *${balance} кредитов*\n\nВыберите нужный инструмент или модель:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Проверить баланс', 'action_balance')],
                    [Markup.button.callback('🤖 Выбрать модель ИИ', 'action_choose_ai')]
                ])
            }
        );
    });

    bot.action('action_balance', async (ctx) => {
        console.log(`💳 Нажата кнопка баланса пользователем ${ctx.from.id}`);
        const balance = await getUserBalance(ctx.from.id);
        await ctx.answerCbQuery();
        await ctx.reply(`💳 Ваш текущий баланс: **${balance} кредитов**.`);
    });

    // 3. Запускаем бота
    await bot.launch();
    console.log('🤖 Ядро бота успешно заведено и слушает сообщения!');
}

module.exports = { startBot };
