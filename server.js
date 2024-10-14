import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { CronJob } from 'cron'; // Aggiungi CronJob per gestire le operazioni pianificate
import poppler from 'pdf-poppler';
import FormData from 'form-data'; // Importa form-data

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Funzione per inviare l'immagine all'API OCR.Space
async function ocrSpaceApi(imagePath) {
    const apiKey = 'K89568537488957'; // La tua chiave API OCR.Space
    const imageBuffer = fs.readFileSync(imagePath); // Leggi l'immagine convertita dal PDF

    const formData = new FormData();
    formData.append('file', imageBuffer, { filename: path.basename(imagePath) });
    formData.append('apikey', apiKey);

    try {
        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: {
                ...formData.getHeaders(),
            },
        });

        return response.data;
    } catch (error) {
        console.error('Errore durante il riconoscimento OCR:', error);
        throw error;
    }
}

// Funzione per convertire il PDF in immagini
async function pdfToImages(pdfPath) {
    const outputDir = path.join(__dirname, 'pdf_images');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    const options = {
        format: 'png',
        out_dir: outputDir,
        out_prefix: 'menu_image',
        page: [3, 4, 5] // Estrai solo le pagine 3, 4 e 5
    };

    try {
        await poppler.convert(pdfPath, options);
        const imageFiles = fs.readdirSync(outputDir).map(file => path.join(outputDir, file));
        return imageFiles; // Restituisce i percorsi delle immagini generate
    } catch (error) {
        console.error('Errore durante la conversione del PDF in immagini:', error);
        throw error;
    }
}

// Funzione per aggiornare il menu
const updateMenu = async () => {
    const pdfUrl = 'https://drive.usercontent.google.com/u/0/uc?id=1FxGRm7RcIw876MDOPd3f32W07LhXTHf2&export=download';
    const pdfPath = path.join(__dirname, 'menu.pdf');

    try {
        // Scarica il PDF
        await downloadPdf(pdfUrl, pdfPath);

        // Converti il PDF in immagini
        const images = await pdfToImages(pdfPath);

        const allPageTexts = [];

        // Esegui il riconoscimento OCR su ogni immagine
        for (const imgPath of images) {
            const ocrResult = await ocrSpaceApi(imgPath);
            const pageText = ocrResult.ParsedResults[0].ParsedText;
            allPageTexts.push(pageText);
        }

        // Creazione dell'oggetto menu JSON
        const menuData = {
            combinazioni: [],
            piatti: [],
            prezzi: [],
            allergeni: [],
        };

        // Le categorie da estrarre
        const categories = ['Primi', 'Secondi', 'Contorni', 'Piatti Unici', 'Le Nostre Pinse', 'Insalatone'];
        const categoryData = {};

        categories.forEach(category => {
            categoryData[category] = [];
        });

        // Analizza il testo e riempi l'oggetto menuData
        allPageTexts.forEach(text => {
            const lines = text.split('\n');
            let currentCategory = null;

            lines.forEach(line => {
                line = line.trim(); // Rimuove spazi bianchi

                // Controlla se la riga è una delle categorie
                if (categories.includes(line)) {
                    currentCategory = line; // Imposta la categoria corrente
                } else if (currentCategory && line.includes('€')) {
                    const priceMatch = line.match(/€\s*\d+(\.\d+)?/);
                    const itemName = line.replace(/(\s*€\s*\d+(\.\d+)?)/, '').trim(); // Rimuove il prezzo dal nome

                    // Aggiunge l'elemento all'oggetto della categoria corrente
                    if (priceMatch) {
                        categoryData[currentCategory].push({
                            name: itemName,
                            price: priceMatch[0],
                        });
                    }
                } else if (currentCategory && line.length > 0) {
                    // Se la riga è un piatto ma non contiene un prezzo, aggiungila come piatto (senza prezzo)
                    categoryData[currentCategory].push({
                        name: line,
                        price: null,
                    });
                }
            });
        });

        // Aggiungi i dati delle categorie all'oggetto menuData
        Object.keys(categoryData).forEach(category => {
            menuData.piatti.push(...categoryData[category]);
        });

        const db = await connectDB();
        await db.query('INSERT INTO menus (menu_data) VALUES (?)', [JSON.stringify(menuData)]);
        console.log('Menu aggiornato nel database:', menuData);
    } catch (error) {
        console.error('Errore durante l\'aggiornamento del menù:', error);
    }
};

// Funzione per inviare gli ordini a Telegram
async function sendOrdersToTelegram() {
    try {
        const db = await connectDB();
        const [orders] = await db.query('SELECT * FROM orders');

        if (orders.length > 0) {
            const message = orders.map(order => `Ordine ID: ${order.id}, Piatto ID: ${order.menu_item_id}, Quantità: ${order.quantity}`).join('\n');
            await axios.post(`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage`, {
                chat_id: '<YOUR_CHAT_ID>',
                text: message,
            });
            console.log('Ordini inviati a Telegram con successo');
        }
    } catch (error) {
        console.error('Errore nell\'invio degli ordini a Telegram:', error);
    }
}

// Funzione per eliminare gli ordini più vecchi di tre giorni
async function deleteOldOrders() {
    const db = await connectDB();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.query('DELETE FROM orders WHERE created_at < ?', [threeDaysAgo]);
}

// Imposta il cron job per inviare gli ordini ogni giorno alle 12:45
const job = new CronJob('45 12 * * *', sendOrdersToTelegram);
job.start();

// Imposta il cron job per eliminare gli ordini ogni giorno alle 14:00
const deleteJob = new CronJob('0 14 * * *', deleteOldOrders);
deleteJob.start();

// Endpoint per estrarre il menù
app.get('/menu', async (req, res) => {
    try {
        await updateMenu();
        const db = await connectDB();
        const [menus] = await db.query('SELECT * FROM menus ORDER BY created_at DESC LIMIT 1');
        if (menus.length > 0) {
            const menuData = menus[0].menu_data; // Mantieni come stringa
            console.log('Menu Data:', menuData); // Log per controllare i dati
            res.json(JSON.parse(menuData)); // Restituisce i dati in formato JSON
        } else {
            res.status(404).send('Nessun menù trovato');
        }
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

// Avvio del server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Inizializza l'aggiornamento del menu all'avvio del server
updateMenu();
