# Standalone TradingView Scraper Datapipeline

This folder contains a fully portable and standalone scraper pipeline. It utilizes Playwright to automate TradingView chart interaction, extracting Pine Script indicator codes and downloading indicator CSV data.

## Prerequisites

- **Node.js**: Install Node.js (version 16 or newer) from [nodejs.org](https://nodejs.org/).

## Setup Instructions

1. **Extract Zip**: Extract the contents of this folder onto your computer.
2. **Credentials Configuration**:
   - Locate the `.env` file in the root directory.
   - Open `.env` in a text editor and configure your TradingView email and password:
     ```env
     TRADINGVIEW_EMAIL=your_email@example.com
     TRADINGVIEW_PASSWORD=your_tradingview_password
     ```
3. **Install Dependencies**:
   Open a terminal (PowerShell, Command Prompt, or terminal on macOS/Linux) in this folder and run:
   ```bash
   npm install
   ```
4. **Install Playwright Browsers**:
   After installing the dependencies, run this command to download the required Playwright Chromium browser binary:
   ```bash
   npx playwright install chromium
   ```

## Running the Scraper

You can run the scraper by specifying indices from the indicator list. 

### Examples:

- **Run both (CSV and Script) for a range of indices (e.g. index 1 to 5)**:
  ```bash
  node pipeline.js --from 1 --to 5
  ```
- **Run only the script extraction**:
  ```bash
  node pipeline.js --from 1 --to 5 --run script
  ```
- **Run only the CSV download**:
  ```bash
  node pipeline.js --from 1 --to 5 --run csv
  ```
- **Run specific indices (e.g. indices 2, 7, and 12)**:
  ```bash
  node pipeline.js --idx 2,7,12
  ```

## Folder Structure

- `pipeline.js`: The main automated script.
- `InputForScript/unique_indicator_names.txt`: The input index of indicators.
- `Finalop1lack/script/`: Destination folder where extracted Pine Scripts are saved.
- `Finalop1lack/csv/`: Destination folder where cleaned CSV data is saved.
- `Logs/`: Log files capturing the scraper output and details.
