#!/bin/bash

# Simple deployment script for USDT Dashboard
# This script helps you push updates to GitHub

echo "🚀 USDT Dashboard Deployment Script"
echo "=================================="

# Check if git is initialized
if [ ! -d ".git" ]; then
    echo "📁 Initializing git repository..."
    git init
    git remote add origin https://github.com/danielgajdos/usdt-dashboard.git
fi

# Add all files
echo "📝 Adding files to git..."
git add .

# Commit with timestamp
TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
echo "💾 Committing changes..."
git commit -m "Update dashboard - $TIMESTAMP"

# Push to GitHub
echo "🌐 Pushing to GitHub..."
git push -u origin main

echo "✅ Deployment complete!"
echo "🔗 Your dashboard will be live at:"
echo "   https://danielgajdos.github.io/usdt-dashboard/"
echo ""
echo "⏱️  Wait 2-3 minutes for GitHub Pages to update"
echo "🔄 Dashboard auto-refreshes every 5 minutes"