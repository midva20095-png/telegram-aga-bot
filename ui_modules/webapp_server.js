const express = require('express');
const path = require('path');

function startWebApp() {
    const app = express();
    const PORT = process.env.PORT || 3000;

    app.use(express.static(path.join(__dirname, 'public')));

    app.listen(PORT, () => {
        console.log(`📱 Интерфейс и Мини-приложение запущены на порту ${PORT}`);
    });
}

module.exports = { startWebApp };
