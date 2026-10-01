require('dotenv').config();
const { startBot } = require('./core/bot');
const { startWebApp } = require('./ui_modules/webapp_server');

console.log('🚀 Запуск системы...');

let app = null;

try {
    app = startWebApp(); // 👈 Сохраняем запущенный сервер
} catch (e) {
    console.error('⚠️ Ошибка запуска WebApp:', e.message);
}

try {
    startBot(app); // 👈 Передаём сервер в бота
} catch (e) {
    console.error('⚠️ Ошибка запуска ядра бота:', e.message);
}
