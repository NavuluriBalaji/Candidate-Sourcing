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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LINKEDIN_USERNAME = process.env.LINKEDIN_USERNAME;
const LINKEDIN_PASSWORD = process.env.LINKEDIN_PASSWORD;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

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
            resolve(answer);
        });
    });
}

async function linkedinLogin(page, username, password) {
    try {
        await page.goto("https://www.linkedin.com/login", { waitUntil: 'networkidle2' });
        await page.waitForSelector('#username', { timeout: 10000 });
        await page.type('#username', username);
        await page.type('#password', password);
        await page.click('button[type="submit"]');
        await page.waitForSelector('.search-global-typeahead__input', { timeout: 20000 });
    } catch (error) {
        throw error;
    }
}

async function scrapeProfileWithGemini(page, url) {
    try {
        await page.setDefaultNavigationTimeout(120000); // Increase navigation timeout to 120s
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
        try {
            await page.waitForSelector('main.scaffold-layout__main, h1.text-heading-xlarge, body', { timeout: 20000 });
        } catch (e) {
            await page.waitForSelector('body', { timeout: 10000 });
        }
        await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
        await new Promise(resolve => setTimeout(resolve, 3000));
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
          "email": "The person's email address. If not found, use an empty string.",
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
        return data;
    } catch (error) {
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
                    args: ['--disable-blink-features=AutomationControlled'],
                    userDataDir: path.join(os.tmpdir(), 'linkedin_scraper_' + Date.now())
                });
                try {
                    const page = await browser.newPage();
                    await page.setDefaultNavigationTimeout(120000); // Set navigation timeout to 120s
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
                    await linkedinLogin(page, username, password);
                    for (const profile of profiles) {
                        const data = await scrapeProfileWithGemini(page, profile.profileurl);
                        data.sno = profile.sno;
                        data.url = profile.profileurl;
                        results.push(data);
                        await new Promise(resolve => setTimeout(resolve, 2000)); // Replace page.waitForTimeout
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
                            { id: 'url', title: 'URL' }
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
        args: ['--disable-blink-features=AutomationControlled'],
        userDataDir: path.join(os.tmpdir(), 'linkedin_scraper_api_' + Date.now())
    });
    try {
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(120000); // Set navigation timeout to 120s
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

// Store scraped profiles in memory for /profiles endpoint
let lastScrapedProfiles = [];

// Use Serper API to search LinkedIn profiles
async function scrapeLinkedinProfiles(params) {
    const { searchTerm, countryCode, pageNumber, yearsOfExperience, region } = params;
    const query = [
        searchTerm,
        yearsOfExperience ? `${yearsOfExperience} years experience` : '',
        region ? region : '',
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

async function main() {
    if (!GEMINI_API_KEY) {
        console.log("Missing GEMINI_API_KEY in .env");
        return;
    }
    if (!LINKEDIN_USERNAME || !LINKEDIN_PASSWORD) {
        console.log("Missing LINKEDIN_USERNAME or LINKEDIN_PASSWORD in .env");
        return;
    }
    try {
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log(`Access Here:http://localhost:${port}/ui.html`));
    } catch (error) {
        console.error("Error:", error.message);
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
