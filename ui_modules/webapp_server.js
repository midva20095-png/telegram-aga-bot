const express = require('express');
const path = require('path');

function startWebApp() {
    const app = express();

    // Обязательно для приема JSON-уведомлений от ЮKassa
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Статические файлы веб-приложения
    app.use(express.static(path.join(__dirname, '../public')));

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, () => {
        console.log(`📱 Интерфейс и Мини-приложение запущены на порту ${PORT}`);
    });

    return app;
}

module.exports = { startWebApp };
