#!/bin/sh
set -e

# Directory where exports are mounted (can be customized via env var)
EXPORT_DIR="${EXPORT_DIR:-/exportdata}"

# Output directory for nginx
OUTPUT_DIR="/usr/share/nginx/html"

# Check if PLATFORM is set for auto-generation
if [ -n "$PLATFORM" ]; then
    echo "Auto-generation mode enabled"
    echo "Platform: $PLATFORM"
    echo "Export directory: $EXPORT_DIR"

    # Validate platform
    case "$PLATFORM" in
        discord|messenger|telegram|whatsapp)
            ;;
        *)
            echo "Error: Invalid PLATFORM '$PLATFORM'. Must be one of: discord, messenger, telegram, whatsapp"
            exit 1
            ;;
    esac

    # Check if export directory exists and has files
    if [ ! -d "$EXPORT_DIR" ]; then
        echo "Error: Export directory '$EXPORT_DIR' does not exist"
        echo "Make sure to mount your export files using: -v /your/local/path:$EXPORT_DIR"
        exit 1
    fi

    # Find files based on platform and check if they exist
    FILES_FOUND=0
    case "$PLATFORM" in
        discord|messenger|telegram)
            if ls "$EXPORT_DIR"/*.json 1> /dev/null 2>&1; then
                FILES_FOUND=1
            fi
            FILE_PATTERN="*.json"
            INPUT_GLOB="$EXPORT_DIR/*.json"
            ;;
        whatsapp)
            if ls "$EXPORT_DIR"/*.txt 1> /dev/null 2>&1 || ls "$EXPORT_DIR"/*.zip 1> /dev/null 2>&1; then
                FILES_FOUND=1
            fi
            FILE_PATTERN="*.txt or *.zip"
            INPUT_GLOB="$EXPORT_DIR/*.txt $EXPORT_DIR/*.zip"
            ;;
    esac

    if [ "$FILES_FOUND" -eq 0 ]; then
        echo "Error: No matching files found in '$EXPORT_DIR' for platform '$PLATFORM'"
        echo "Expected file pattern: $FILE_PATTERN"
        exit 1
    fi

    echo "Found export files:"
    ls -la "$EXPORT_DIR"

    echo "Generating report..."

    # Check for DEMO flag
    DEMO_FLAG=""
    if [ "$DEMO" = "true" ] || [ "$DEMO" = "1" ]; then
        DEMO_FLAG="--demo"
        echo "Demo mode: enabled"
    fi

    # Generate the report using the CLI
    # Note: INPUT_GLOB is intentionally unquoted to allow glob expansion
    cd /chat-analytics
    node dist/lib/CLI.js -p "$PLATFORM" -i $INPUT_GLOB -o "$OUTPUT_DIR/index.html" $DEMO_FLAG

    echo "Report generated successfully at $OUTPUT_DIR/index.html"
else
    echo "Serving web app (no auto-generation)"
    echo "To auto-generate a report, set PLATFORM environment variable"
    echo "Example: docker run -e PLATFORM=discord -v /path/to/exports:/exportdata ..."
fi

echo "Starting nginx..."
exec nginx -g "daemon off;"
