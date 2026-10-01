require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

let aiPlugin = null;
try {
    aiPlugin = require('../ai_plugins/google_gemini_plugin');
    console.log('✅ Плагин Google Gemini успешно подключен к ядру');
} catch (e) {
    console.warn('⚠️️ Внимание: Плагин ИИ не найден!');
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const userActiveMode = new Map();

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

// Строгие функции работы с Google Apps Script
async function getUserBalance(userId) {
    try {
        console.log(`📤 Запрос баланса для userId=${userId} через Apps Script...`);
        const response = await axios.get(`${process.env.GOOGLE_SCRIPT_URL}?action=get&userId=${userId}`, { timeout: 10000 });
        console.log(`📥 Ответ от Apps Script:`, response.data);
        return response.data && response.data.balance !== undefined ? parseInt(response.data.balance) : null;
    } catch (error) {
        console.error("❌ Ошибка чтения баланса через Google Apps Script:", error.message);
        return null;
    }
}

async function updateBalanceInSheet(userId, amount) {
    try {
        console.log(`📤 Изменение баланса на ${amount} для userId=${userId} через Apps Script...`);
        const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
            action: 'update',
            userId: userId,
            amount: amount
        }, { timeout: 10000 });
        console.log(`📥 Ответ обновления от Apps Script:`, response.data);
        return response.data && response.data.balance !== undefined ? parseInt(response.data.balance) : null;
    } catch (error) {
        console.error("❌ Ошибка изменения баланса через Google Apps Script:", error.message);
        return null;
    }
}

async function startBot() {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('🧹 Старый вебхук успешно сброшен.');
    } catch (e) {
        console.log('ℹ️ Вебхук:', e.message);
    }

    bot.start(async (ctx) => {
        const userId = ctx.from.id;
        userActiveMode.set(userId, 'flash');
        
        const balance = await getUserBalance(userId);
        const displayBalance = balance !== null ? balance : 'ошибка связи с таблицей';
        
        await ctx.reply(
            `🤖 Бот запущен.\n💳 Ваш баланс: *${displayBalance} кредитов*\n\nВыберите нужный инструмент:`,
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
        await ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;
        const balance = await getUserBalance(userId);
        const displayBalance = balance !== null ? balance : 'не удалось получить';
        await ctx.reply(`💳 Ваш текущий баланс: *${displayBalance} кредитов*.`, { parse_mode: 'Markdown' });
    });

    bot.action('action_choose_ai', async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        await ctx.editMessageText('🤖 Выберите модель ИИ для работы:', Markup.inlineKeyboard([
            [Markup.button.callback(`⚡ ${MODEL_NAMES['flash']} (${MODEL_COSTS['flash']} кр.)`, 'set_model_flash')],
            [Markup.button.callback(`🧠 ${MODEL_NAMES['pro']} (${MODEL_COSTS['pro']} кр.)`, 'set_model_pro')],
            [Markup.button.callback(`🍌 ${MODEL_NAMES['nanobanana']} (${MODEL_COSTS['nanobanana']} кр.)`, 'set_model_nanobanana')],
            [Markup.button.callback(`🚀 ${MODEL_NAMES['nanobanana_pro']} (${MODEL_COSTS['nanobanana_pro']} кр.)`, 'set_model_nanobanana_pro')],
            [Markup.button.callback('🔙 Назад', 'action_back_start')]
        ]));
    });

    for (const modelKey of Object.keys(MODEL_COSTS)) {
        bot.action(`set_model_${modelKey}`, async (ctx) => {
            await ctx.answerCbQuery().catch(() => {});
            userActiveMode.set(ctx.from.id, modelKey);
            await ctx.editMessageText(
                `✅ Активная модель изменена на: *${MODEL_NAMES[modelKey]}*\nСтоимость запроса: ${MODEL_COSTS[modelKey]} кр.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🤖 Выбрать другую модель', 'action_choose_ai')],
                        [Markup.button.callback('💳 Проверить баланс', 'action_balance')]
                    ])
                }
            );
        });
    }

    bot.action('action_back_start', async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        const userId = ctx.from.id;
        const balance = await getUserBalance(userId);
        const displayBalance = balance !== null ? balance : '...';
        const currentMode = userActiveMode.get(userId) || 'flash';
        
        await ctx.editMessageText(
            `🤖 Главное меню.\n💳 Баланс: *${displayBalance} кредитов*\n⚙️ Модель: *${MODEL_NAMES[currentMode]}*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Проверить баланс', 'action_balance')],
                    [Markup.button.callback('🤖 Выбрать модель ИИ', 'action_choose_ai')]
                ])
            }
        );
    });

    bot.on(['text', 'photo', 'document', 'video', 'audio'], async (ctx) => {
        if (!aiPlugin) {
            return ctx.reply('❌ Ошибка: ИИ-плагин не установлен.');
        }

        const userId = ctx.from.id;
        const currentModel = userActiveMode.get(userId) || 'flash';
        const cost = MODEL_COSTS[currentModel];

        // Проверяем баланс через таблицу
        const balance = await getUserBalance(userId);
        if (balance === null) {
            return ctx.reply('⚠️ Ошибка связи с таблицей Google Apps Script. Не удалось проверить баланс.');
        }
        if (balance < cost) {
            return ctx.reply(`❌ Недостаточно кредитов!\n\nВаш баланс: ${balance} кр.\nТребуется для "${MODEL_NAMES[currentModel]}": ${cost} кр.`);
        }

        let prompt = ctx.message.text || ctx.message.caption || "";
        let fileBuffer = null;
        let mimeType = 'text/plain';

        const statusMsg = await ctx.reply(`⏳ Обрабатываю через *${MODEL_NAMES[currentModel]}* (списание: ${cost} кр.)...`, { parse_mode: 'Markdown' });

        try {
            if (ctx.message.photo) {
                const photo = ctx.message.photo[ctx.message.photo.length - 1];
                const fileLink = await bot.telegram.getFileLink(photo.file_id);
                const res = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
                fileBuffer = Buffer.from(res.data);
                mimeType = 'image/jpeg';
            } else if (ctx.message.document) {
                const doc = ctx.message.document;
                const fileLink = await bot.telegram.getFileLink(doc.file_id);
                const res = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
                fileBuffer = Buffer.from(res.data);
                mimeType = doc.mime_type || 'application/octet-stream';
            }

            // Вызываем ИИ
            const aiResult = await aiPlugin.processRequest({
                prompt: prompt,
                fileBuffer: fileBuffer,
                mimeType: mimeType,
                modelKey: currentModel,
                userId: userId
            });

            // Списываем кредиты в таблице (передаем отрицательное значение)
            const newBalance = await updateBalanceInSheet(userId, -cost);
            const displayNewBalance = newBalance !== null ? newBalance : (balance - cost);

            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

            if (aiResult.type === 'image' && aiResult.buffer) {
                await ctx.replyWithPhoto(
                    { source: aiResult.buffer },
                    { caption: `${aiResult.text}\n\n_📌 Списано: ${cost} кр. | Остаток: ${displayNewBalance} кр._`, parse_mode: 'Markdown' }
                );
            } else {
                await ctx.reply(
                    `${aiResult.text}\n\n_📌 Списано: ${cost} кр. | Остаток: ${displayNewBalance} кр._`,
                    { parse_mode: 'Markdown' }
                );
            }

        } catch (error) {
            console.error("Ошибка при обработке запроса ИИ:", error);
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Ошибка выполнения ИИ-запроса.').catch(() => {});
        }
    });

    await bot.launch();
    console.log('🤖 Ядро с поддержкой Google Таблиц успешно запущено!');
}

module.exports = { startBot };
