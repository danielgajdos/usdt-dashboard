const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'portfolio.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const storage = {
    saveState: (state) => {
        try {
            fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
            return true;
        } catch (error) {
            console.error('Failed to save state:', error);
            return false;
        }
    },

    loadState: () => {
        try {
            if (fs.existsSync(DATA_FILE)) {
                const data = fs.readFileSync(DATA_FILE, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Failed to load state:', error);
        }
        return null;
    }
};

module.exports = storage;
