import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import fs from 'fs';
import axios from 'axios';
import { CronJob } from 'cron';
import path from 'path';
import { PDFDocument } from 'pdf-lib'; // Mantieni solo pdf-lib
import { dirname } from 'path';
import { createCanvas, loadImage } from 'canvas'; // Assicurati di importare anche createCanvas
import { fileURLToPath } from 'url'; // Importa fileURLToPath
import tesseract from 'tesseract.js';

const __filename = fileURLToPath(import.meta.url); // Define __filename
const __dirname = dirname(__filename); // Define __dirname

const app = express();
app.use(cors());
app.use(express.json());

// Configurazione del database
const dbConfig = {
    host: '172.22.175.10',
    user: 'db_user',
    password: 'db_user_pass',
    database: 'learning_platform',
    port: 3306,
};

// Funzione per connettersi al database
async function connectDB() {
    return await mysql.createConnection(dbConfig);
}

// Funzione per scaricare il PDF
async function downloadPdf(url, outputPath) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    fs.writeFileSync(outputPath, response.data);
}

// Funzione per analizzare il testo estratto dal PDF
const getParsedMenu = (pageContents) => {
    const inputCombinazioni = pageContents[1];
    const inputPiatti = pageContents[2];
    const inputPinse = pageContents[3];
    const inputInsalate = pageContents[4];

    const repeatedBlanksPattern = new RegExp(/\s+/g);
    const notePattern = new RegExp(/\(.\)/g);
    const itemPattern = new RegExp(/[a-z]([^]*?€)?.*/gi);
    const itemNamePattern = new RegExp(/.*?(?=[:€]|$)/i);
    const itemIngredientsPattern = new RegExp(/(?<=:).*?(?=€|$)/i);
    const itemPricePattern = new RegExp(/(?<=€).*/);

    const getText = str => str.replace(/^[^a-z]*/i, '').replace(/[^a-z]*$/i, '') || undefined;
    const getNumber = str => {
        const digits = (str.match(/\d+([.,]\d+)?/) || [''])[0];
        return digits ? Number(digits) : undefined;
    };

    const getName = item => getText((item.match(itemNamePattern) || [''])[0]);
    const getIngredients = item => getText((item.match(itemIngredientsPattern) || [''])[0]);
    const getPrice = item => getNumber((item.match(itemPricePattern) || [''])[0]);

    const getItems = block => (
        block.replace(notePattern, '').match(itemPattern) || []
    ).map(itemText => itemText.replace(repeatedBlanksPattern, ' '));

    const getMenuEntry = item => {
        const name = getName(item) || item;
        const ingredients = getIngredients(item);
        const price = getPrice(item);
        return Object.assign({ name },
            ingredients !== undefined && { ingredients },
            price !== undefined && { price }
        );
    };

    const sections = {
        combinazioni: inputCombinazioni,
        pinse: inputPinse,
        primi: inputPiatti,
        secondi: inputPiatti,
        insalate: inputInsalate
    };

    return Object.fromEntries(Object.entries(sections).map(([sectionName, block]) => [sectionName, getItems(block).map(item => getMenuEntry(item))]));
};

// Funzione per aggiornare il menu
const updateMenu = async () => {
    const pdfUrl = 'https://drive.usercontent.google.com/u/0/uc?id=1FxGRm7RcIw876MDOPd3f32W07LhXTHf2&export=download';
    const pdfPath = path.join(__dirname, 'menu.pdf');

    try {
        // Scarica il PDF
        await downloadPdf(pdfUrl, pdfPath);

        // Converti il PDF in immagini
        const pdfBuffer = fs.readFileSync(pdfPath);
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const images = [];

        for (let i = 0; i < pdfDoc.getPageCount(); i++) {
            const page = pdfDoc.getPage(i);
            const { width, height } = page.getSize();
            const canvas = createCanvas(width, height);
            const context = canvas.getContext('2d');

            // Imposta la dimensione del canvas
            const scale = 2; // Modifica il valore di scala se necessario
            canvas.width = width * scale;
            canvas.height = height * scale;

            // Imposta il colore di sfondo
            context.fillStyle = 'white';
            context.fillRect(0, 0, canvas.width, canvas.height);

            // Renderizza il contenuto della pagina sul canvas
            // Nota: La libreria pdf-lib non supporta il rendering diretto come immagini, quindi
            // in questo caso dovresti trovare un modo per disegnare il contenuto della pagina.
            // Potresti dover utilizzare una libreria aggiuntiva per ottenere le immagini delle pagine.

            // Salva l'immagine come PNG
            const imgPath = path.join(__dirname, `menu_image_${i}.png`);
            const buffer = canvas.toBuffer('image/png');
            fs.writeFileSync(imgPath, buffer);
            images.push(imgPath);
        }

        // Passa le immagini a Tesseract
        const allPageTexts = [];
        for (const imgPath of images) {
            const langsArr = ['ita']; // Inizializzazione dell'array delle lingue
            console.log('Lingue passate a Tesseract:', langsArr);

            // Controllo se langsArr è un array prima di chiamare map
            if (Array.isArray(langsArr)) {
                const langString = langsArr.join('+'); // Unisci le lingue in una stringa con '+'
                console.log('Tipo di lang prima di Tesseract:', typeof langString, Array.isArray(langString) ? 'È un array' : 'Non è un array');

                // Tenta di riconoscere il testo
                try {
                    const pageText = await tesseract.recognize(imgPath, {
                        lang: langString,
                        dpi: 256
                    });
                    allPageTexts.push(pageText.data.text);
                } catch (error) {
                    console.error('Errore durante l\'estrazione del testo da', imgPath, error);
                }
            } else {
                console.error('langsArr non è un array:', langsArr);
            }
        }

        // Analizza il menu
        const menu = getParsedMenu(allPageTexts);

        // Salva il menu nel database
        const db = await connectDB();
        await db.query('INSERT INTO menus (menu_data) VALUES (?)', [JSON.stringify(menu)]);
        console.log("Menu aggiornato nel database:", menu);
    } catch (error) {
        console.error('Errore durante l\'aggiornamento del menù:', error);
    }
};

// Endpoint per estrarre il menù
app.get('/menu', async (req, res) => {
    try {
        await updateMenu(); // Chiama updateMenu per assicurarti che il menu sia aggiornato
        const db = await connectDB();
        const [menus] = await db.query('SELECT * FROM menus ORDER BY created_at DESC LIMIT 1');
        res.json(menus[0].menu_data);
    } catch (error) {
        console.error('Errore nel recupero del menù:', error);
        res.status(500).send('Errore nel recupero del menù');
    }
});

// Endpoint per inviare un ordine
app.post('/order', async (req, res) => {
    const { userId, menuItemId, quantity } = req.body;

    try {
        const db = await connectDB();
        await db.query('INSERT INTO orders (user_id, menu_item_id, quantity) VALUES (?, ?, ?)', [userId, menuItemId, quantity]);
        res.send('Ordine inviato con successo');
    } catch (error) {
        console.error('Errore durante l\'invio dell\'ordine:', error);
        res.status(500).send('Errore durante l\'invio dell\'ordine');
    }
});

// Funzione per inviare gli ordini a Telegram
async function sendOrdersToTelegram() {
    try {
        const db = await connectDB();
        const [orders] = await db.query('SELECT * FROM orders'); // Recupera gli ordini

        if (orders.length > 0) {
            const message = orders.map(order => `Ordine ID: ${order.id}, Piatto ID: ${order.menu_item_id}, Quantità: ${order.quantity}`).join('\n');
            await axios.post(`https://api.telegram.org/botY7692172708:AAGu2XKgpQaJZuh8t7fhpdrE2bJSoEtyCJE/sendMessage`, {
                chat_id: '884749209',
                text: message,
            });
            console.log('Ordini inviati a Telegram con successo');
        }
    } catch (error) {
        console.error('Errore nell\'invio degli ordini a Telegram:', error);
    }
}

// Imposta il cron job per inviare gli ordini ogni giorno alle 12:45
const job = new CronJob('45 12 * * *', sendOrdersToTelegram);
job.start();

// Funzione per eliminare gli ordini più vecchi di tre giorni
async function deleteOldOrders() {
    const db = await connectDB();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.query('DELETE FROM orders WHERE created_at < ?', [threeDaysAgo]);
}

// Imposta il cron job per eliminare gli ordini ogni giorno alle 14:00
const deleteJob = new CronJob('0 14 * * *', deleteOldOrders);
deleteJob.start();

// Avvio del server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Inizializza l'aggiornamento del menu all'avvio del server
updateMenu();
