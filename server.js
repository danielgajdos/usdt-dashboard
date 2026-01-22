const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const dotenv = require('dotenv');
const { startBot, botState } = require('./index');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// -- Middleware --
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public')); // For tailwind/css if needed
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_key_change_me',
    resave: false,
    saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

// -- Passport Config --
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
    },
        function (accessToken, refreshToken, profile, done) {
            if (profile.emails && profile.emails[0].value === 'daniel.gajdos@gmail.com') {
                return done(null, profile);
            } else {
                return done(null, false, { message: 'Unauthorized email' });
            }
        }
    ));
} else {
    console.warn('WARNING: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing. Auth will fail.');
}

// -- Middleware to check Auth --
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

// -- Routes --

app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    function (req, res) {
        res.redirect('/dashboard');
    }
);

app.get('/dashboard', ensureAuthenticated, (req, res) => {
    res.render('dashboard', {
        user: req.user,
        botState: botState
    });
});

app.post('/api/start', ensureAuthenticated, (req, res) => {
    startBot();
    res.json({ success: true, message: 'Bot started' });
});

app.get('/api/status', ensureAuthenticated, (req, res) => {
    res.json(botState);
});

// -- Start Server --
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    // Optionally start bot automatically on server start
    startBot();
});
