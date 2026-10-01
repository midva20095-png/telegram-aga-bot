const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * СЛОВАРЬ МОДЕЛЕЙ И ВОЗМОЖНОСТЕЙ
 * Используем правильные имена моделей из актуальной документации Google
 */
const MODEL_MAPPING = {
    'flash': 'gemini-3.8-flash',                    // Текстовая модель
    'pro': 'gemini-2.5-pro',                    // Профессиональная текстовая модель
    'nanobanana': 'gemini-3.1-flash-image',    // Модель для генерации и редактирования изображений
    'nanobanana_pro': 'gemini-3.1-flash-image' // Версия Pro для продвинутой работы с графикой
};

async function processRequest({ prompt, fileBuffer, mimeType, modelKey = 'flash', imageConfig }) {
    try {
        const resolvedModel = MODEL_MAPPING[modelKey] || MODEL_MAPPING['flash'];

        console.log(`⚙️ Вызов метода для ключа [${modelKey}], маппинг на модель: "${resolvedModel}"`);

        // --- БЛОК 1: ГЕНЕРАЦИЯ И РЕДАКТИРОВАНИЕ ИЗОБРАЖЕНИЙ (по новому стандарту interactions) ---
        if (modelKey === 'nanobanana' || modelKey === 'nanobanana_pro') {
            console.log(`🎨 Запуск генерации/обработки изображений через interactions с промптом: "${prompt}"`);
            
            // Формируем входные данные в соответствии с документацией Google
            let inputPayload = [];

            // Если пользователь прикрепил картинку (режим редактирования / image-to-image)
            if (fileBuffer && Buffer.isBuffer(fileBuffer) && fileBuffer.length > 0) {
                inputPayload.push({
                    type: "image",
                    data: fileBuffer.toString("base64"),
                    mime_type: mimeType || "image/png"
                });
            }

            // Добавляем текстовый промпт
            inputPayload.push({
                type: "text",
                text: prompt || "Create a creative image"
            });

            // Конфигурация запроса (добавлены опции из документации: aspect_ratio, image_size и т.д.)
            const interactionPayload = {
                model: resolvedModel,
                input: inputPayload.length === 1 ? inputPayload[0].text : inputPayload,
            };

            if (imageConfig) {
                interactionPayload.config = imageConfig;
            }

            // Оборачиваем в промис с увеличенным до 120с таймаутом для генерации графики
            const imageGenerationPromise = ai.interactions.create(interactionPayload);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Превышено время ожидания генерации изображения (120с)')), 120000)
            );

            const interaction = await Promise.race([imageGenerationPromise, timeoutPromise]);

            // Проверяем наличие выходного изображения в ответе
            if (interaction && interaction.output_image && interaction.output_image.data) {
                const base64Image = interaction.output_image.data;
                return {
                    type: 'image',
                    buffer: Buffer.from(base64Image, 'base64'),
                    text: '🎨 Изображение успешно создано!'
                };
            }
            
            throw new Error('Интерфейс Google не вернул данные изображения.');
        }

        // --- БЛОК 2: СТАНДАРТНЫЙ ТЕКСТ / МУЛЬТИМОДАЛ (Flash, Pro) ---
        let contents = [];

        if (fileBuffer && Buffer.isBuffer(fileBuffer) && fileBuffer.length > 0) {
            contents.push({
                inlineData: {
                    data: fileBuffer.toString("base64"),
                    mimeType: mimeType || 'application/octet-stream'
                }
            });
        }
        
        contents.push(prompt || "Привет!");

        console.log(`💬 Отправка текстового запроса в модель: ${resolvedModel}...`);
        
        const generatePromise = ai.models.generateContent({
            model: resolvedModel,
            contents: contents,
        });

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Превышено время ожидания ответа от Google AI')), 30000)
        );

        const response = await Promise.race([generatePromise, timeoutPromise]);

        return {
            type: 'text',
            text: response.text || "Готово!"
        };

    } catch (error) {
        console.error(`❌ Ошибка в плагине [модель: ${modelKey}]:`, error.message || error);
        throw new Error("⚠️ Ошибка связи с нейросетью Google: " + (error.message || 'Неизвестная ошибка'));
    }
}

module.exports = { processRequest };