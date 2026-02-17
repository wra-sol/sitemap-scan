#!/bin/bash

# Development script for Multi-Site Backup System

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

# Function to show menu
show_menu() {
    echo "Multi-Site Backup Development Menu"
    echo "================================="
    echo "1. Start development server"
    echo "2. Build project"
    echo "3. Run linting"
    echo "4. Run type checking"
    echo "5. Install dependencies"
    echo "6. Fix linting issues"
    echo "7. Run tests"
    echo "8. Setup environment"
    echo "9. Exit"
    echo ""
    echo -n "Choose an option (1-9): "
}

# Development server
start_dev_server() {
    log_info "Starting development server..."
    npm run dev
}

# Build project
build_project() {
    log_info "Building project..."
    npm run build
    if [ $? -eq 0 ]; then
        log_success "Build completed successfully."
    else
        echo "Build failed!"
        exit 1
    fi
}

# Run linting
run_linting() {
    log_info "Running ESLint..."
    npm run lint
}

# Type checking
run_type_check() {
    log_info "Running TypeScript type checking..."
    npm run build
}

# Install dependencies
install_deps() {
    log_info "Installing dependencies..."
    npm install
    log_success "Dependencies installed."
}

# Fix linting issues
fix_linting() {
    log_info "Auto-fixing linting issues..."
    npm run lint -- --fix
}

# Run tests
run_tests() {
    log_info "Running tests..."
    npm test
}

# Setup environment
setup_environment() {
    log_info "Setting up development environment..."
    
    if [ ! -f ".env" ]; then
        log_info "Creating .env file..."
        cat > .env << EOF
# Development environment variables
KV_NAMESPACE_ID=your-kv-namespace-id-here
PREVIEW_KV_ID=your-preview-kv-namespace-id-here
DEFAULT_SLACK_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/HERE

# Wrangler configuration
CLOUDFLARE_API_TOKEN=your-api-token-here
CLOUDFLARE_ACCOUNT_ID=your-account-id-here
EOF
        log_success "Created .env file. Please update it with your values."
    else
        log_warning ".env file already exists."
    fi
    
    log_info "Don't forget to:"
    echo "  1. Create KV namespaces: wrangler kv:namespace create \"BACKUP_KV\""
    echo "  2. Update wrangler.toml with KV namespace IDs"
    echo "  3. Set secrets: wrangler secret put DEFAULT_SLACK_WEBHOOK"
    echo "  4. Configure your site configurations"
}

# Main menu loop
while true; do
    show_menu
    read -r choice
    
    case $choice in
        1)
            start_dev_server
            ;;
        2)
            build_project
            ;;
        3)
            run_linting
            ;;
        4)
            run_type_check
            ;;
        5)
            install_deps
            ;;
        6)
            fix_linting
            ;;
        7)
            run_tests
            ;;
        8)
            setup_environment
            ;;
        9)
            log_info "Goodbye!"
            exit 0
            ;;
        *)
            echo "Invalid option. Please choose 1-9."
            ;;
    esac
    
    echo ""
    read -p "Press Enter to continue..."
done