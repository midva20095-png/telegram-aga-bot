
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

module.exports = startBot;
