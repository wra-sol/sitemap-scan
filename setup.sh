#!/bin/bash

# Multi-Site Backup System - Setup and Management Script

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="development"
KV_NAMESPACE=""
PREVIEW_KV=""
SLACK_WEBHOOK=""
WORKER_NAME="multi-site-backup"

# Helper functions
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

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js 18 or later."
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed."
        exit 1
    fi
    
    if ! command -v wrangler &> /dev/null; then
        log_error "Wrangler CLI is not installed. Please install it with: npm install -g wrangler"
        exit 1
    fi
    
    # Check if user is logged in to Cloudflare
    if ! wrangler whoami &> /dev/null; then
        log_warning "You are not logged in to Cloudflare. Please run: wrangler auth login"
        exit 1
    fi
    
    log_success "Prerequisites check passed."
}

# Install dependencies
install_dependencies() {
    log_info "Installing dependencies..."
    npm install
    log_success "Dependencies installed."
}

# Create KV namespace
create_kv_namespace() {
    log_info "Creating KV namespace..."
    
    if [ -z "$KV_NAMESPACE" ]; then
        KV_NAME=$(wrangler kv:namespace create "BACKUP_KV" | grep -o 'id = "[^"]*"' | cut -d'"' -f2)
        PREVIEW_NAME=$(wrangler kv:namespace create "BACKUP_KV" --preview | grep -o 'id = "[^"]*"' | cut -d'"' -f2)
        
        log_info "Created KV namespace with ID: $KV_NAME"
        log_info "Created preview KV namespace with ID: $PREVIEW_NAME"
        
        # Update wrangler.toml
        sed -i.bak "s/your-kv-namespace-id-here/$KV_NAME/" wrangler.toml
        sed -i.bak "s/your-preview-kv-namespace-id-here/$PREVIEW_NAME/" wrangler.toml
        rm wrangler.toml.bak
        
        log_success "Updated wrangler.toml with KV namespace IDs."
    else
        log_info "Using provided KV namespace ID: $KV_NAMESPACE"
        sed -i.bak "s/your-kv-namespace-id-here/$KV_NAMESPACE/" wrangler.toml
        rm wrangler.toml.bak
    fi
}

# Set secrets
set_secrets() {
    log_info "Setting secrets..."
    
    if [ -n "$SLACK_WEBHOOK" ]; then
        echo "$SLACK_WEBLOG" | wrangler secret put DEFAULT_SLACK_WEBHOOK
        log_success "Set DEFAULT_SLACK_WEBHOOK secret."
    else
        log_warning "No Slack webhook provided. You can set it later with: wrangler secret put DEFAULT_SLACK_WEBHOOK"
    fi
}

# Deploy worker
deploy_worker() {
    log_info "Deploying worker to $ENVIRONMENT environment..."
    
    if [ "$ENVIRONMENT" != "development" ]; then
        wrangler deploy --env "$ENVIRONMENT"
    else
        wrangler deploy
    fi
    
    log_success "Worker deployed successfully."
}

# Load example configurations
load_examples() {
    log_info "Loading example site configurations..."
    
    # Read the example configurations and load them into KV
    python3 << 'EOF'
import json
import requests
import sys

try:
    with open('example-configurations.json', 'r') as f:
        sites = json.load(f)
    
    worker_url = input("Enter your worker URL (e.g., https://your-worker.your-subdomain.workers.dev): ")
    
    for site in sites:
        response = requests.post(f"{worker_url}/api/sites", json=site)
        if response.status_code == 201:
            print(f"✓ Loaded site: {site['id']}")
        else:
            print(f"✗ Failed to load site {site['id']}: {response.text}")
    
    print("\nAll example configurations processed.")
except Exception as e:
    print(f"Error loading configurations: {e}")
    sys.exit(1)
EOF
}

# Test deployment
test_deployment() {
    log_info "Testing deployment..."
    
    WORKER_URL=$(wrangler whoami | grep "Current User" | awk '{print $3}' || echo "")
    if [ -n "$WORKER_URL" ]; then
        # Test health endpoint
        if curl -s -f "$WORKER_URL/api/status" > /dev/null; then
            log_success "Health check passed."
        else
            log_warning "Health check failed. Worker might not be fully deployed yet."
        fi
        
        # Test Slack notification if webhook is set
        if [ -n "$SLACK_WEBHOOK" ]; then
            log_info "Testing Slack notification..."
            curl -s -X POST "$WORKER_URL/api/slack/test" \
                -H "Content-Type: application/json" \
                -d "{\"webhook\":\"$SLACK_WEBHOOK\"}" > /dev/null
            log_success "Slack test notification sent."
        fi
    fi
}

# Show usage
show_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -e, --environment ENV    Set environment (development|staging|production) [default: development]"
    echo "  -k, --kv-id ID          Use existing KV namespace ID"
    echo "  -s, --slack-webhook URL Set Slack webhook URL"
    echo "  -l, --load-examples     Load example site configurations"
    echo "  -h, --help              Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Full setup with new KV namespace"
    echo "  $0 -e production -s https://hooks.slack.com/...  # Deploy to production"
    echo "  $0 -k abc123-def456                   # Use existing KV namespace"
    echo "  $0 -l                                 # Load example configurations only"
}

# Main setup function
main() {
    log_info "Starting Multi-Site Backup System setup..."
    
    check_prerequisites
    install_dependencies
    create_kv_namespace
    set_secrets
    deploy_worker
    test_deployment
    
    log_success "Setup completed successfully!"
    log_info "Your worker is deployed and ready to use."
    log_info "Next steps:"
    echo "  1. Add site configurations via the API or use: $0 -l"
    echo "  2. Monitor your Slack channel for notifications"
    echo "  3. Check /api/status for system health"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -k|--kv-id)
            KV_NAMESPACE="$2"
            shift 2
            ;;
        -s|--slack-webhook)
            SLACK_WEBHOOK="$2"
            shift 2
            ;;
        -l|--load-examples)
            load_examples
            exit 0
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Run main function
main