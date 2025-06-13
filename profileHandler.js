```javascript
// profileHandler.js

// ...existing code...

async function sendSampleMessageIfNeeded(userId) {
    // Check if message already sent (implement your own logic/storage)
    const alreadySent = await checkIfMessageSent(userId);
    if (!alreadySent) {
        await sendSampleMessage(userId);
        await markMessageAsSent(userId);
    }
}

async function onProfileLoaded(userId) {
    await sendSampleMessageIfNeeded(userId);
    await scrapeProfile(userId);
}

// ...existing code...
```