const express = require('express');
const path = require('path');

function startWebApp() {
    const app = express();

    // Парсер JSON для приёма уведомлений от ЮKassa
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Обслуживание файлов мини-приложения
    app.use(express.static(path.join(__dirname, '../public')));

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, () => {
        console.log(`📱 Интерфейс и Мини-приложение запущены на порту ${PORT}`);
    });

    return app; // 👈 Главное: отдаём сервер дальше
}

module.exports = { startWebApp };
