#!/bin/bash

# Deployment script for Multi-Site Backup System

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    log_error "Wrangler CLI is not installed. Please install it with: npm install -g wrangler"
    exit 1
fi

# Parse command line arguments
ENVIRONMENT="development"
HELP=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -h|--help)
            HELP=true
            shift
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [ "$HELP" = true ]; then
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -e, --environment ENV  Set environment (development|staging|production) [default: development]"
    echo "  -h, --help           Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                    # Deploy to development"
    echo "  $0 -e production     # Deploy to production"
    echo "  $0 -e staging        # Deploy to staging"
    exit 0
fi

log_info "Starting deployment to $ENVIRONMENT environment..."

# Build the project
log_info "Building project..."
npm run build
if [ $? -eq 0 ]; then
    log_success "Build completed successfully."
else
    log_error "Build failed."
    exit 1
fi

# Deploy to specified environment
log_info "Deploying to $ENVIRONMENT..."
if [ "$ENVIRONMENT" = "development" ]; then
    wrangler deploy
else
    wrangler deploy --env "$ENVIRONMENT"
fi

if [ $? -eq 0 ]; then
    log_success "Deployment to $ENVIRONMENT completed successfully!"
    
    # Get the worker URL
    WORKER_URL=$(wrangler whoami | grep "Account ID" | head -1 | awk '{print $3}' || echo "")
    if [ -n "$WORKER_URL" ]; then
        log_info "Your worker is deployed at: https://multi-site-backup.$WORKER_URL.workers.dev"
    fi
    
    log_info "Next steps:"
    echo "  1. Set your Slack webhook: wrangler secret put DEFAULT_SLACK_WEBHOOK"
    echo "  2. Create KV namespace: wrangler kv:namespace create \"BACKUP_KV\""
    echo "  3. Update wrangler.toml with your KV namespace ID"
    echo "  4. Add site configurations via API or use example-configurations.json"
else
    log_error "Deployment failed."
    exit 1
fi