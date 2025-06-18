require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cheerio = require('cheerio');
const readline = require('readline');
const os = require('os');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
const upload = multer({ dest: 'uploads/' });

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function prompt(question) {
    return new Promise(resolve => {
        rl.question(question, answer => {
            resolve(answer.trim());
        });
    });
}

let GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let LINKEDIN_USERNAME = process.env.LINKEDIN_USERNAME;
let LINKEDIN_PASSWORD = process.env.LINKEDIN_PASSWORD;
let SERPER_API_KEY = process.env.SERPER_API_KEY;

let envReady = !!(GEMINI_API_KEY && LINKEDIN_USERNAME && LINKEDIN_PASSWORD && SERPER_API_KEY);

app.get('/env', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
        </head>
        <body>
            <div class="env-container">
                <h2>Provide Required API Keys & Credentials</h2>
                <div class="help">
                    <b>Instructions:</b>
                    <ul>
                        <li><b>GEMINI_API_KEY</b>: <a href="https://aistudio.google.com/app/apikey" target="_blank">Get from Google AI Studio</a></li>
                        <li><b>SERPER_API_KEY</b>: <a href="https://serper.dev" target="_blank">Sign up at serper.dev</a></li>
                        <li><b>LINKEDIN_USERNAME</b> & <b>LINKEDIN_PASSWORD</b>: Your LinkedIn login credentials</li>
                    </ul>
                    <div>After submitting, you will be redirected to the application.</div>
                </div>
                <form method="POST" action="/env${req.query.redirect ? '?redirect=1' : ''}">
                    <label for="GEMINI_API_KEY">GEMINI_API_KEY</label>
                    <input type="text" id="GEMINI_API_KEY" name="GEMINI_API_KEY" required autocomplete="off" />
                    <label for="SERPER_API_KEY">SERPER_API_KEY</label>
                    <input type="text" id="SERPER_API_KEY" name="SERPER_API_KEY" required autocomplete="off" />
                    <label for="LINKEDIN_USERNAME">LINKEDIN_USERNAME</label>
                    <input type="text" id="LINKEDIN_USERNAME" name="LINKEDIN_USERNAME" required autocomplete="off" />
                    <label for="LINKEDIN_PASSWORD">LINKEDIN_PASSWORD</label>
                    <input type="password" id="LINKEDIN_PASSWORD" name="LINKEDIN_PASSWORD" required autocomplete="off" />
                    <button type="submit">Save & Continue</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/env', express.urlencoded({ extended: true }), (req, res) => {
    GEMINI_API_KEY = req.body.GEMINI_API_KEY?.trim();
    SERPER_API_KEY = req.body.SERPER_API_KEY?.trim();
    LINKEDIN_USERNAME = req.body.LINKEDIN_USERNAME?.trim();
    LINKEDIN_PASSWORD = req.body.LINKEDIN_PASSWORD?.trim();
    envReady = !!(GEMINI_API_KEY && LINKEDIN_USERNAME && LINKEDIN_PASSWORD && SERPER_API_KEY);
    if (!envReady) {
        return res.send('<div style="color:red;padding:2em;">All fields are required. <a href="/env">Go back</a></div>');
    }
    process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    process.env.SERPER_API_KEY = SERPER_API_KEY;
    process.env.LINKEDIN_USERNAME = LINKEDIN_USERNAME;
    process.env.LINKEDIN_PASSWORD = LINKEDIN_PASSWORD;
    initializeGenAI();
    if (req.query.redirect) {
        return res.redirect('/ui.html');
    }
    res.redirect('/');
});

app.use((req, res, next) => {
    if (!envReady && req.path !== '/env' && req.method !== 'POST') {
        return res.redirect('/env');
    }
    next();
});

async function linkedinLogin(page, username, password) {
    try {
        await page.goto("https://www.linkedin.com/login", { waitUntil: 'networkidle2', timeout: 90000 });
        await page.waitForSelector('#username', { timeout: 40000 });
        await page.type('#username', username, { delay: 50 });
        await page.type('#password', password, { delay: 50 });
        await page.click('button[type="submit"]');
        // Wait for login or security check
        let loggedIn = false;
        for (let i = 0; i < 5; i++) {
            try {
                await Promise.race([
                    page.waitForSelector('.search-global-typeahead__input', { timeout: 15000 }),
                    page.waitForSelector('img.global-nav__me-photo, .global-nav__me-photo', { timeout: 15000 }),
                    page.waitForSelector('input#input__email_verification_pin', { timeout: 15000 }),
                    page.waitForSelector('form.challenge', { timeout: 15000 }),
                    page.waitForSelector('div[data-test="captcha-container"]', { timeout: 15000 })
                ]);
                // Check for security check
                if (await page.$('input#input__email_verification_pin')) {
                    // Wait for user to manually enter the PIN code sent to email
                    console.log('Please complete the email verification PIN in the browser...');
                    await page.waitForSelector('.search-global-typeahead__input, img.global-nav__me-photo, .global-nav__me-photo', { timeout: 180000 });
                } else if (await page.$('form.challenge') || await page.$('div[data-test="captcha-container"]')) {
                    // Wait for user to solve captcha or challenge
                    console.log('Please complete the LinkedIn security check (captcha/challenge) in the browser...');
                    await page.waitForSelector('.search-global-typeahead__input, img.global-nav__me-photo, .global-nav__me-photo', { timeout: 180000 });
                }
                loggedIn = true;
                break;
            } catch (e) {
                // Retry if not logged in yet
            }
        }
        if (!loggedIn) throw new Error('LinkedIn login failed or security check not passed.');
    } catch (error) {
        throw error;
    }
}

async function sendSampleMessageIfNeededOnLoadedPage(page, profileUrl, userName) {
    if (messagedUsers.has(profileUrl)) return true;
    try {
        // 1. Click the message button
        const selectors = [
            '.scaffold-layout-toolbar .artdeco-button.artdeco-button--2.artdeco-button--primary.ember-view.pvs-sticky-header-profile-actions__action',
            'button[aria-label^="Message"]',
            'button[aria-label*="Message"]',
            'a[aria-label^="Message"]',
            'a[aria-label*="Message"]',
            'button[data-control-name="message"]'
        ];
        let found = false;
        for (const selector of selectors) {
            const btn = await page.$(selector);
            if (btn) {
                await btn.focus();
                await btn.click();
                found = true;
                break;
            }
        }
        if (!found) throw new Error('Message button not found');

        // 2. Wait for message input and type the message
        await page.waitForSelector('div.msg-form__contenteditable', { timeout: 10000 });
        await page.type('div.msg-form__contenteditable', `Hi ${userName}\nHow are you doing?`);

        // 3. Wait for and click the send button (ensure it is enabled)
        const sendBtnSelector = '.msg-form__send-button.artdeco-button.artdeco-button--1';
        await page.waitForSelector(sendBtnSelector, { timeout: 10000 });
        // Wait until the send button is enabled (not disabled)
        await page.waitForFunction(
            selector => {
                const btn = document.querySelector(selector);
                return btn && !btn.disabled;
            },
            { timeout: 10000 },
            sendBtnSelector
        );
        await page.click(sendBtnSelector);

        messagedUsers.add(profileUrl);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 4. Close the message popup (X button)
        try {
            const closeBtnSelector = '.msg-overlay-bubble-header__control.artdeco-button.artdeco-button--circle.artdeco-button--muted.artdeco-button--1.artdeco-button--tertiary.ember-view';
            await page.waitForSelector(closeBtnSelector, { timeout: 5000 });
            const closeBtns = await page.$$(closeBtnSelector);
            for (const btn of closeBtns) {
                const icon = await btn.$('.artdeco-button__icon');
                if (icon) {
                    await btn.click();
                    break;
                }
            }
        } catch (e) {
            // If close fails, ignore and move on
        }

        return true;
    } catch (e) {
        if (e.message && e.message.includes('waiting for selector')) {
            throw new Error('You need a premium account to send messages to this user.');
        }
        return false;
    }
}

async function scrapeProfileWithGemini(page, url) {
    try {
        await page.setDefaultNavigationTimeout(60000);
        let loaded = false, attempts = 0, maxAttempts = 2;
        let lastError = null;
        while (!loaded && attempts < maxAttempts) {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                loaded = true;
            } catch (err) {
                lastError = err;
                attempts++;
                if (attempts < maxAttempts) {
                    await new Promise(res => setTimeout(res, 1000));
                }
            }
        }
        if (!loaded) throw lastError || new Error('Failed to load profile page');
        try {
            await page.waitForSelector('main.scaffold-layout__main, h1.text-heading-xlarge, body', { timeout: 8000 });
        } catch (e) {
            await page.waitForSelector('body', { timeout: 4000 });
        }
        await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
        await new Promise(resolve => setTimeout(resolve, 500));
        const htmlContent = await page.content();
        const prompt = `
        You are an expert data extractor. Based on the following HTML from a LinkedIn profile,
        extract the specified information.

        Return ONLY a single valid JSON object with the following structure and nothing else.
        Do not include \`\`\`json at the beginning or \`\`\` at the end.

        JSON structure to follow:
        {
          "name": "Full Name",
          "headline": "Professional headline",
          "location": "City, State, Country",
          "about": "The full text from the 'About' section. If missing, use an empty string.",
          "email": "The person's email  . If not found, use an empty string.",
          "experience": [
            {
              "role": "Job Title",
              "company": "Company Name",
              "duration": "Dates of employment, e.g., 'Jan 2022 - Present'"
            }
          ]
        }

        Here is the HTML content:
        <html>
        ${htmlContent}
        </html>
        `;
        const model = genAI.getGenerativeModel({
            model: "gemini-2.0-flash",
            generationConfig: { responseMimeType: "application/json" }
        });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const data = JSON.parse(response.text());
        if (data.experience && Array.isArray(data.experience) && data.experience.length > 0) {
            data.experience = data.experience
                .map(job => `${job.role || ''} at ${job.company || ''}`)
                .join('; ');
        } else {
            data.experience = '';
        }
        await sendSampleMessageIfNeededOnLoadedPage(page, url, data.name);
        return data;
    } catch (error) {
        console.error(`Error scraping profile ${url}:`, error.message);
        return { error: error.message };
    }
}

async function scrapeProfilesFromCSV(csvPath, username, password) {
    return new Promise(async (resolve, reject) => {
        const profiles = [];
        const results = [];
        fs.createReadStream(csvPath)
            .pipe(csv())
            .on('data', (data) => {
                const normalizedData = {};
                Object.keys(data).forEach(key => {
                    const normalizedKey = key.trim().toLowerCase()
                        .replace(/\./g, '')
                        .replace(/\s/g, '')
                        .replace(/_/g, '');
                    normalizedData[normalizedKey] = data[key];
                });
                if (normalizedData.profileurl && normalizedData.sno) {
                    profiles.push({
                        sno: normalizedData.sno,
                        profileurl: normalizedData.profileurl
                    });
                }
            })
            .on('end', async () => {
                if (profiles.length === 0) {
                    reject(new Error("CSV must contain 'ProfileURL' and 'SNo' columns."));
                    return;
                }
                const browser = await puppeteer.launch({
                    headless: false,
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--start-maximized'
                    ],
                    userDataDir: path.join(os.tmpdir(), 'linkedin_scraper_' + Date.now()),
                    defaultViewport: null
                });
                try {
                    const page = await browser.newPage();
                    await page.setDefaultNavigationTimeout(120000);
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
                    await linkedinLogin(page, username, password);
                    for (const profile of profiles) {
                        // Wait for previous navigation to finish before moving to next profile
                        let loaded = false, attempts = 0, maxAttempts = 2, lastError = null;
                        while (!loaded && attempts < maxAttempts) {
                            try {
                                await page.goto(profile.profileurl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                                loaded = true;
                            } catch (err) {
                                lastError = err;
                                attempts++;
                                if (attempts < maxAttempts) {
                                    await new Promise(res => setTimeout(res, 1000));
                                }
                            }
                        }
                        if (!loaded) {
                            results.push({
                                error: lastError ? lastError.message : 'Failed to load profile page',
                                sno: profile.sno,
                                url: profile.profileurl
                            });
                            continue;
                        }
                        // Wait for profile main content to be visible before sending message
                        try {
                            await page.waitForSelector('main.scaffold-layout__main, h1.text-heading-xlarge, body', { timeout: 8000 });
                        } catch (e) {
                            await page.waitForSelector('body', { timeout: 4000 });
                        }
                        await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
                        await new Promise(resolve => setTimeout(resolve, 500));
                        // Scrape and send message
                        let scrapedData = {};
                        try {
                            const htmlContent = await page.content();
                            const prompt = `
                            You are an expert data extractor. Based on the following HTML from a LinkedIn profile,
                            extract the specified information.

                            Return ONLY a single valid JSON object with the following structure and nothing else.
                            Do not include \`\`\`json at the beginning or \`\`\` at the end.

                            JSON structure to follow:
                            {
                              "name": "Full Name",
                              "headline": "Professional headline",
                              "location": "City, State, Country",
                              "about": "The full text from the 'About' section. If missing, use an empty string.",
                              "email": "The person's email  . If not found, use an empty string.",
                              "experience": [
                                {
                                  "role": "Job Title",
                                  "company": "Company Name",
                                  "duration": "Dates of employment, e.g., 'Jan 2022 - Present'"
                                }
                              ]
                            }

                            Here is the HTML content:
                            <html>
                            ${htmlContent}
                            </html>
                            `;
                            const model = genAI.getGenerativeModel({
                                model: "gemini-2.0-flash",
                                generationConfig: { responseMimeType: "application/json" }
                            });
                            const result = await model.generateContent(prompt);
                            const response = await result.response;
                            scrapedData = JSON.parse(response.text());
                            if (scrapedData.experience && Array.isArray(scrapedData.experience) && scrapedData.experience.length > 0) {
                                scrapedData.experience = scrapedData.experience
                                    .map(job => `${job.role || ''} at ${job.company || ''}`)
                                    .join('; ');
                            } else {
                                scrapedData.experience = '';
                            }
                        } catch (err) {
                            results.push({
                                error: err.message,
                                sno: profile.sno,
                                url: profile.profileurl
                            });
                            continue;
                        }
                        let messageSent = false;
                        try {
                            // Wait for message to be sent before moving to next profile
                            messageSent = await sendSampleMessageIfNeededOnLoadedPage(page, profile.profileurl, scrapedData.name);
                        } catch (e) {
                            scrapedData.message_error = e.message;
                        }
                        scrapedData.sno = profile.sno;
                        scrapedData.url = profile.profileurl;
                        scrapedData.message_sent = messageSent ? 'Yes' : 'No';
                        results.push(scrapedData);
                        // Wait a bit before next navigation to avoid LinkedIn rate limits
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    const csvWriter = createCsvWriter({
                        path: 'profile_details_gemini_cleaned.csv',
                        header: [
                            { id: 'sno', title: 'SNo' },
                            { id: 'name', title: 'Name' },
                            { id: 'headline', title: 'Headline' },
                            { id: 'location', title: 'Location' },
                            { id: 'about', title: 'About' },
                            { id: 'email', title: 'Email' },
                            { id: 'experience', title: 'Experience' },
                            { id: 'url', title: 'URL' },
                            { id: 'message_sent', title: 'Message Sent' }
                        ]
                    });
                    await csvWriter.writeRecords(results);
                    resolve(results);
                } catch (error) {
                    reject(error);
                } finally {
                    await browser.close();
                }
            })
            .on('error', reject);
    });
}

async function getLinkedInProfile(firstName, lastName) {
    const browser = await puppeteer.launch({ headless: false });
    try {
        const page = await browser.newPage();
        await page.goto("https://linkedin.com/uas/login", { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 5000));
        const userName = await prompt("User Name: ");
        const password = await prompt("Password: ");
        await page.type('#username', userName);
        await page.type('#password', password);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await page.click('button[type="submit"]');
        await new Promise(resolve => setTimeout(resolve, 5000));
        const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${firstName}+${lastName}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 10000));
        const profileLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/in/"]'));
            return [...new Set(links.map(link => link.href))];
        });
        if (profileLinks.length === 0) {
            return;
        }
        const profileUrl = profileLinks[0];
        await page.goto(profileUrl, { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 8000));
        const profileData = await page.evaluate(() => {
            const name = document.querySelector('h1')?.textContent?.trim() || '';
            const nameParts = name.split(' ');
            const firstname = nameParts[0] || '';
            const lastname = nameParts.slice(1).join(' ') || '';
            const location = document.querySelector('.text-body-small.inline.t-black--light.break-words')?.textContent?.trim() || '';
            return {
                firstname,
                lastname,
                location,
                email: '',
                experience: ''
            };
        });
        try {
            await page.click('a[href*="/contact-info/"]');
            await new Promise(resolve => setTimeout(resolve, 2000));
            const email = await page.evaluate(() => {
                const emailElement = document.querySelector('a[href^="mailto:"]');
                return emailElement ? emailElement.textContent.trim() : '';
            });
            profileData.email = email;
            await page.click('button[aria-label="Dismiss"]');
        } catch (error) {}
        const experience = await page.evaluate(() => {
            const expSection = document.querySelector('section[id*="experience"]');
            if (!expSection) return [];
            const experienceItems = [];
            const listItems = expSection.querySelectorAll('li.artdeco-list__item');
            listItems.forEach(item => {
                const roleElement = item.querySelector('span[aria-hidden="true"]');
                const role = roleElement ? roleElement.textContent.trim() : '';
                const companyElement = item.querySelector('.t-14.t-normal span[aria-hidden="true"]');
                const company = companyElement ? companyElement.textContent.trim() : '';
                if (role || company) {
                    experienceItems.push(`${role} at ${company}`.replace(' at ', ' at ').trim());
                }
            });
            return experienceItems;
        });
        profileData.experience = experience.join('; ');
        const csvWriter = createCsvWriter({
            path: 'linkedin_profile_basic.csv',
            header: [
                { id: 'firstname', title: 'First Name' },
                { id: 'lastname', title: 'Last Name' },
                { id: 'location', title: 'Location' },
                { id: 'email', title: 'Email' },
                { id: 'experience', title: 'Experience' }
            ]
        });
        await csvWriter.writeRecords([profileData]);
    } finally {
        await browser.close();
        rl.close();
    }
}

app.post('/scrape', async (req, res) => {
    const { url, username, password } = req.body;
    const user = username || LINKEDIN_USERNAME;
    const pass = password || LINKEDIN_PASSWORD;
    if (!url || !user || !pass) {
        return res.status(400).json({ error: 'Missing url, username, or password' });
    }
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
        ],
        userDataDir: path.join(os.tmpdir(), 'linkedin_scraper_api_' + Date.now()),
        defaultViewport: null
    });
    try {
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(120000);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await linkedinLogin(page, user, pass);
        const result = await scrapeProfileWithGemini(page, url);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        await browser.close();
    }
});

app.post('/scrape-csv', upload.single('csv'), async (req, res) => {
    const username = req.body.username || LINKEDIN_USERNAME;
    const password = req.body.password || LINKEDIN_PASSWORD;
    if (!req.file || !username || !password) {
        return res.status(400).json({ error: 'Missing file, username, or password' });
    }
    try {
        const results = await scrapeProfilesFromCSV(req.file.path, username, password);
        fs.unlinkSync(req.file.path);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

let lastScrapedProfiles = [];

async function scrapeLinkedinProfiles(params) {
    const { searchTerm, countryCode, pageNumber, yearsOfExperience, region } = params;
    const query = [
        searchTerm,
        yearsOfExperience ? `${yearsOfExperience} years experience` : '',
        region ? region : '',
        '"open to work"',
        'site:linkedin.com/in'
    ].filter(Boolean).join(' ');
    const apiUrl = 'https://google.serper.dev/search';
    const payload = {
        q: query,
        gl: countryCode || 'us',
        page: pageNumber ? Number(pageNumber) : 1
    };
    const headers = {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
    };
    try {
        const response = await axios.post(apiUrl, payload, { headers });
        const links = [];
        if (response.data && Array.isArray(response.data.organic)) {
            for (const result of response.data.organic) {
                if (result.link && result.link.includes('linkedin.com/in/')) {
                    links.push(result.link);
                }
            }
        }
        return links;
    } catch (err) {
        console.error('Serper API error:', err.message);
        return [];
    }
}

app.post('/run', async (req, res) => {
    const params = req.body;
    try {
        const profiles = await scrapeLinkedinProfiles(params);
        lastScrapedProfiles = profiles;
        res.json({ success: true, count: profiles.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/profiles', (req, res) => {
    res.json(lastScrapedProfiles);
});

let genAI = null;

function initializeGenAI() {
    if (envReady && GEMINI_API_KEY && !genAI) {
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    }
}

app.post('/env', express.urlencoded({ extended: true }), (req, res) => {
    GEMINI_API_KEY = req.body.GEMINI_API_KEY?.trim();
    SERPER_API_KEY = req.body.SERPER_API_KEY?.trim();
    LINKEDIN_USERNAME = req.body.LINKEDIN_USERNAME?.trim();
    LINKEDIN_PASSWORD = req.body.LINKEDIN_PASSWORD?.trim();
    envReady = !!(GEMINI_API_KEY && LINKEDIN_USERNAME && LINKEDIN_PASSWORD && SERPER_API_KEY);
    if (!envReady) {
        return res.send('<div style="color:red;padding:2em;">All fields are required. <a href="/env">Go back</a></div>');
    }
    process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    process.env.SERPER_API_KEY = SERPER_API_KEY;
    process.env.LINKEDIN_USERNAME = LINKEDIN_USERNAME;
    process.env.LINKEDIN_PASSWORD = LINKEDIN_PASSWORD;
    initializeGenAI();
    if (req.query.redirect) {
        return res.redirect('/ui.html');
    }
    res.redirect('/');
});

if (envReady) {
    initializeGenAI();
}

async function main() {
    try {
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log(`Access Here: http://localhost:${port}/ui.html`));
    } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
    }
}

module.exports = {
    scrapeProfilesFromCSV,
    getLinkedInProfile,
    scrapeProfileWithGemini,
    app
};

if (require.main === module) {
    main();
}

const messagedUsers = new Set();
if (envReady && !genAI) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}
main();
// Also call initializeGenAI on startup if envReady
if (envReady) {
    initializeGenAI();
}

async function main() {
    try {
        // await ensureEnvVars(); // No longer prompt in CLI
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log(`Access Here: http://localhost:${port}/ui.html`));
    } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
    }
}

module.exports = {
    scrapeProfilesFromCSV,
    getLinkedInProfile,
    scrapeProfileWithGemini,
    app
};

if (require.main === module) {
    main();
}

// const messagedUsers = new Set();
if (envReady && !genAI) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
}
    main();

