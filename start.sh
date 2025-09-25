#!/bin/bash

# Production start script using PM2
echo "🚀 Starting Trader Production Environment with PM2..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 is not installed. Installing globally..."
    npm install -g pm2
fi

# Stop existing PM2 processes
pm2 delete trader-backend trader-worker trader-frontend 2>/dev/null

# Build frontend
echo "🔨 Building frontend..."
npm run build

# Start using PM2 ecosystem file
echo "📦 Starting services with PM2..."
pm2 start ecosystem.config.js
pm2 save

# Show status
pm2 status

echo "✅ Production environment started!"
echo ""
echo "📊 PM2 Commands:"
echo "   pm2 status       - Show status"
echo "   pm2 logs         - Show logs"
echo "   pm2 monit        - Monitor processes"
echo "   pm2 stop all     - Stop all processes"
echo "   pm2 restart all  - Restart all processes"
echo ""
echo "🌐 Access points:"
echo "   Frontend: http://localhost:8080"
echo "   Backend API: http://localhost:3001"

