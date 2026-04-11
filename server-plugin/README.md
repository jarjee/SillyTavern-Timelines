# Timelines Data Server Plugin

This server plugin provides a consolidated endpoint for the SillyTavern-Timelines extension, reducing the number of API requests from N+1 down to just 1.

## What It Does

The plugin adds a new endpoint `/api/plugins/timelines-data/bulk-fetch` that:
- Fetches all chat files for a character/group in one request
- Builds timeline graph elements server-side (optionally with dagre layout positions)
- Caches responses for 30 seconds to avoid redundant file I/O

**Performance improvement**: For a character with 10 chats, this reduces **11 requests to 1 request** (~10x fewer requests).

## Installation

### Option 1: Copy Plugin File (Recommended)

1. Copy the `server-plugin/` directory to your SillyTavern installation:
   ```bash
   cp -r server-plugin/ /path/to/SillyTavern/plugins/timelines-data
   ```

2. Enable server plugins in your SillyTavern config:
   - Edit `config.yaml` in your SillyTavern root directory
   - Find or add: `enableServerPlugins: true`
   - Save and restart SillyTavern

3. Verify the plugin loaded:
   - Check SillyTavern console for: `Timelines Data plugin loaded! Endpoint: /api/plugins/timelines-data/bulk-fetch`

### Option 2: Symbolic Link

If you want the plugin to stay with the Timelines extension:

```bash
ln -s /path/to/SillyTavern-Timelines/server-plugin /path/to/SillyTavern/plugins/timelines-data
```

Then enable server plugins (same as Option 1, steps 2-3).

## Configuration

The plugin automatically detects SillyTavern's configuration:
- **Chat directory**: Uses `config.chatsPath` or defaults to `./chats`
- **Characters directory**: Uses `config.charactersPath` or defaults to `./characters`

No additional configuration needed in the plugin itself.

## API Endpoints

### Bulk Fetch (Main Endpoint)

**POST** `/api/plugins/timelines-data/bulk-fetch`

**Request body:**
```json
{
  "avatar_url": "character_name.png",
  "is_group": false
}
```

**Response:**
```json
{
  "graph": [
    { "group": "nodes", "data": { "id": "root", "label": "root", ... } },
    { "group": "nodes", "data": { "id": "message1", "msg": "...", ... } },
    { "group": "edges", "data": { "id": "edge1", "source": "root", "target": "message1" } }
  ],
  "metadata": {
    "chat_name_1.jsonl": {
      "file_size": "12.45kb",
      "chat_items": 42,
      "mes": "Last message text",
      "last_mes": 1234567890
    },
    ...
  },
  "serverComputed": true
}
```

Notes:

- `serverComputed=true` means layout positions were computed server-side (when `layout_settings` is sent in the request body).
- `serverComputed=false` means graph data was built server-side but layout is expected client-side.

### Invalidate Cache (Admin)

**POST** `/api/plugins/timelines-data/invalidate-cache`

Clear cached responses for efficiency (optional):
```json
{
  "avatar_url": "character_name.png",
  "is_group": false
}
```

Or clear all cache:
```json
{}
```

## Features

- ✅ **Response caching**: 30-second TTL to reduce file I/O on repeated requests
- ✅ **Both chat modes**: Supports individual character and group chats
- ✅ **Error handling**: Gracefully skips inaccessible files and continues
- ✅ **Graph + metadata**: Timeline graph payload and chat metadata in one response
- ✅ **Auto-detection**: Finds chat/character directories automatically

## Performance and Debug Env Vars

Optional environment variables:

- `TIMELINES_LAYOUT_DEBUG`
  - Set to `1` to enable extra layout diagnostics in perf logs.

Example:

```bash
TIMELINES_LAYOUT_DEBUG=1 npm start
```

## Troubleshooting

### Plugin not loading?

1. Verify `enableServerPlugins: true` in `config.yaml`
2. Check console for errors during server startup
3. Ensure plugin file is readable: `ls -la plugins/timelines-data/`
4. Restart SillyTavern server completely (not just browser refresh)

### Endpoint returns 404?

- Plugin failed to load (check console)
- Server plugins not enabled in config
- URL is incorrect (should be `/api/plugins/timelines-data/bulk-fetch`)

### Empty chats returned?

- Character directory doesn't exist
- No `.jsonl` files in character's chat directory
- File permissions issues (check file readability)

## Extension Compatibility

The Timelines extension will:
1. Try the new plugin endpoint first
2. If the plugin is not installed, automatically fall back to the old multi-request method
3. Work either way, but with better performance if the plugin is installed

You don't need to reinstall the extension after installing the plugin—it will automatically detect and use it on the next data refresh.

## Technical Notes

- **Cache key**: Based on `avatar_url` + `is_group` + serialized `layout_settings`
- **Cache TTL**: 30 seconds (tunable in `CACHE_TTL` constant)
- **File reading**: Uses Node.js `fs.promises` for async I/O
- **Error handling**: Individual file errors don't block other files from loading
- **File sorting**: Chats sorted by filename in reverse alphabetical order (newest first)

## License

Same as SillyTavern-Timelines (MIT)
