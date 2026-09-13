# HorizonXI Profit Scanner

This is a real server-backed starter, not a local HTML mock.

## Run
1. Install Node.js 18+.
2. In this folder: `npm install`
3. Run: `npm start`
4. Open `http://localhost:3000`

## Deploy
Deploy the folder to a Node-compatible host and use `npm start`.

The first live test is Fire Crystal. The backend fetches the PSXI HorizonXI item page and returns Single/Stack price and stock to the browser.

Important: this build deliberately does not claim a full Top-20 scan yet. That requires loading HorizonXI recipe data and applying pricing/liquidity rules across recipes. Build and verify the live data connector first.
