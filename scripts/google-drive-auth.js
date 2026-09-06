require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_DRIVE_CLIENT_ID,
  process.env.GOOGLE_DRIVE_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
});

console.log('AUTH_URL_START');
console.log(authUrl);
console.log('AUTH_URL_END');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.end('ignored');
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');

  if (!code) {
    res.end('No code received.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.end('Authorized! You can close this tab.');

    console.log('REFRESH_TOKEN_START');
    console.log(tokens.refresh_token);
    console.log('REFRESH_TOKEN_END');

    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('GOOGLE_DRIVE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(
        /GOOGLE_DRIVE_REFRESH_TOKEN=.*/,
        `GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`
      );
    } else {
      envContent += `\nGOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
    }
    fs.writeFileSync(envPath, envContent);
    console.log('.env updated with refresh token.');
  } catch (err) {
    console.error('TOKEN_EXCHANGE_ERROR', err.message);
    res.end('Error exchanging code for token: ' + err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for OAuth redirect on ${REDIRECT_URI} ...`);
});
