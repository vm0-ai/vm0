#!/bin/bash
# Minimal VAS POC - Content-addressed storage with deduplication

BLOB_DIR="./vas-storage/blobs"
INDEX_DIR="./vas-storage/indexes"

# Initialize storage
init_storage() {
    mkdir -p "$BLOB_DIR" "$INDEX_DIR"
}

# Compute SHA256 hash of file
hash_file() {
    sha256sum "$1" | awk '{print $1}'
}

# Create checkpoint
checkpoint() {
    local workspace="$1"
    local checkpoint_name="$2"
    local index_file="$INDEX_DIR/$checkpoint_name.json"

    echo "Creating checkpoint: $checkpoint_name"
    echo "{" > "$index_file"
    echo '  "version": "'"$checkpoint_name"'",' >> "$index_file"
    echo '  "files": [' >> "$index_file"

    local first=true
    local total_size=0
    local new_blobs=0

    # Find all files and compute hashes
    while IFS= read -r -d '' file; do
        local rel_path="${file#$workspace/}"
        local hash=$(hash_file "$file")
        local size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file")
        local blob_path="$BLOB_DIR/$hash"

        # Upload blob if not exists (deduplication)
        if [ ! -f "$blob_path" ]; then
            cp "$file" "$blob_path"
            new_blobs=$((new_blobs + 1))
        fi

        total_size=$((total_size + size))

        # Add to index
        if [ "$first" = true ]; then
            first=false
        else
            echo "," >> "$index_file"
        fi

        echo -n "    {\"path\": \"$rel_path\", \"hash\": \"$hash\", \"size\": $size}" >> "$index_file"
    done < <(find "$workspace" -type f -print0)

    echo "" >> "$index_file"
    echo '  ]' >> "$index_file"
    echo '}' >> "$index_file"

    echo "Checkpoint created: $new_blobs new blobs, $((total_size / 1024 / 1024)) MB total"
}

# Restore checkpoint
restore() {
    local checkpoint_name="$1"
    local target_dir="$2"
    local index_file="$INDEX_DIR/$checkpoint_name.json"

    echo "Restoring checkpoint: $checkpoint_name"

    mkdir -p "$target_dir"

    # Parse index and restore files
    local paths=$(jq -r '.files[].path' "$index_file")
    local hashes=$(jq -r '.files[].hash' "$index_file")

    local i=0
    for path in $paths; do
        local hash=$(echo "$hashes" | sed -n "$((i+1))p")
        local target_path="$target_dir/$path"
        local blob_path="$BLOB_DIR/$hash"

        mkdir -p "$(dirname "$target_path")"
        cp "$blob_path" "$target_path"

        i=$((i+1))
    done

    echo "Restore complete"
}

# Main command router
case "$1" in
    init)
        init_storage
        ;;
    checkpoint)
        checkpoint "$2" "$3"
        ;;
    restore)
        restore "$2" "$3"
        ;;
    *)
        echo "Usage: $0 {init|checkpoint <workspace> <name>|restore <name> <target>}"
        exit 1
        ;;
esac
