-- thumbfast.lua
--
-- High-performance on-the-fly thumbnailer
--
-- Built for easy integration in third-party UIs.

--[[
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
]]

local options = {
    -- Socket path (leave empty for auto)
    socket = "",

    -- Thumbnail path (leave empty for auto)
    thumbnail = "",

    -- Maximum thumbnail generation size in pixels (scaled down to fit)
    -- Values are scaled when hidpi is enabled
    max_height = 200,
    max_width = 200,

    -- Scale factor for thumbnail display size (requires mpv 0.38+)
    -- Note that this is lower quality than increasing max_height and max_width
    scale_factor = 1,

    -- Apply tone-mapping, no to disable
    tone_mapping = "auto",

    -- Overlay id
    overlay_id = 42,

    -- Spawn thumbnailer on file load for faster initial thumbnails
    spawn_first = false,

    -- Close thumbnailer process after an inactivity period in seconds, 0 to disable
    quit_after_inactivity = 0,

    -- Enable on network playback
    network = false,

    -- Enable on audio playback
    audio = false,

    -- Enable hardware decoding
    hwdec = false,

    -- Windows only: use native Windows API to write to pipe (requires LuaJIT)
    direct_io = false,

    -- Custom path to the mpv executable
    mpv_path = "mpv",

    -- Timeline thumbnail cache (fork addition). Coarse thumbnails are decoded once
    -- across the whole timeline and kept on disk, so hovering a region shows an
    -- instant approximate frame while the exact one is still being fetched/decoded.
    cache_enabled = true,

    -- How many thumbnails to spread across the timeline. The clip is divided into
    -- this many equal segments and one frame is cached per segment, so 20 caches a
    -- frame every 5% of the duration.
    cache_thumbnails = 20,

    -- Seconds after file load before the background cache pass starts, so it does
    -- not fight the player for bandwidth while playback is still buffering
    cache_prebuild_delay = 5,

    -- Rough bandwidth budget for the background pass, in megabits per second. mpv
    -- has no download rate limiter, so this is not a hard cap: it is enforced by
    -- pacing, waiting after each fetch in proportion to how long that fetch took and
    -- how much faster the stream is than this budget. On a high bitrate stream that
    -- makes prebuilding very slow, which is the intended trade. 0 disables pacing.
    cache_bandwidth_mbps = 1,

    -- Never fetch a background frame while the player's own buffer is below this
    -- many seconds. This is the real protection against starving playback, since it
    -- reacts to actual buffer health rather than a guessed rate.
    cache_min_buffer_secs = 20,

    -- Seconds of hover inactivity before the background cache pass resumes
    cache_idle_delay = 0.75,

    -- Give up on one background cache frame after this many seconds
    cache_timeout = 20,

    -- How many times to retry a timed-out cache entry before giving up on it
    cache_attempts = 2
}

mp.utils = require "mp.utils"
mp.options = require "mp.options"
mp.options.read_options(options, "thumbfast")

local properties = {}
local pre_0_30_0 = mp.command_native_async == nil
local pre_0_33_0 = true
local support_media_control = mp.get_property_native("media-controls") ~= nil

function subprocess(args, async, callback)
    callback = callback or function() end

    if not pre_0_30_0 then
        if async then
            return mp.command_native_async({name = "subprocess", playback_only = true, args = args}, callback)
        else
            return mp.command_native({name = "subprocess", playback_only = false, capture_stdout = true, args = args})
        end
    else
        if async then
            return mp.utils.subprocess_detached({args = args}, callback)
        else
            return mp.utils.subprocess({args = args})
        end
    end
end

local winapi = {}
if options.direct_io then
    local ffi_loaded, ffi = pcall(require, "ffi")
    if ffi_loaded then
        winapi = {
            ffi = ffi,
            C = ffi.C,
            bit = require("bit"),
            socket_wc = "",

            -- WinAPI constants
            CP_UTF8 = 65001,
            GENERIC_WRITE = 0x40000000,
            OPEN_EXISTING = 3,
            FILE_FLAG_WRITE_THROUGH = 0x80000000,
            FILE_FLAG_NO_BUFFERING = 0x20000000,
            PIPE_NOWAIT = ffi.new("unsigned long[1]", 0x00000001),

            INVALID_HANDLE_VALUE = ffi.cast("void*", -1),

            -- don't care about how many bytes WriteFile wrote, so allocate something to store the result once
            _lpNumberOfBytesWritten = ffi.new("unsigned long[1]"),
        }
        -- cache flags used in run() to avoid bor() call
        winapi._createfile_pipe_flags = winapi.bit.bor(winapi.FILE_FLAG_WRITE_THROUGH, winapi.FILE_FLAG_NO_BUFFERING)

        ffi.cdef[[
            void* __stdcall CreateFileW(const wchar_t *lpFileName, unsigned long dwDesiredAccess, unsigned long dwShareMode, void *lpSecurityAttributes, unsigned long dwCreationDisposition, unsigned long dwFlagsAndAttributes, void *hTemplateFile);
            bool __stdcall WriteFile(void *hFile, const void *lpBuffer, unsigned long nNumberOfBytesToWrite, unsigned long *lpNumberOfBytesWritten, void *lpOverlapped);
            bool __stdcall CloseHandle(void *hObject);
            bool __stdcall SetNamedPipeHandleState(void *hNamedPipe, unsigned long *lpMode, unsigned long *lpMaxCollectionCount, unsigned long *lpCollectDataTimeout);
            int __stdcall MultiByteToWideChar(unsigned int CodePage, unsigned long dwFlags, const char *lpMultiByteStr, int cbMultiByte, wchar_t *lpWideCharStr, int cchWideChar);
        ]]

        winapi.MultiByteToWideChar = function(MultiByteStr)
            if MultiByteStr then
                local utf16_len = winapi.C.MultiByteToWideChar(winapi.CP_UTF8, 0, MultiByteStr, -1, nil, 0)
                if utf16_len > 0 then
                    local utf16_str = winapi.ffi.new("wchar_t[?]", utf16_len)
                    if winapi.C.MultiByteToWideChar(winapi.CP_UTF8, 0, MultiByteStr, -1, utf16_str, utf16_len) > 0 then
                        return utf16_str
                    end
                end
            end
            return ""
        end

    else
        options.direct_io = false
    end
end

local file
local file_bytes = 0
local spawned = false
local disabled = false
local force_disabled = false
local spawn_waiting = false
local spawn_working = false
local script_written = false

local dirty = false

local x, y
local last_x, last_y

local last_seek_time

local effective_w, effective_h = options.max_width, options.max_height
local real_w, real_h
local last_real_w, last_real_h

local script_name

local show_thumbnail = false

-- Timeline thumbnail cache (fork addition).
-- Slots are numbered 1..count and each covers `interval` seconds of the timeline.
-- A filled slot is a standalone .bgra file written exactly once, so a file the
-- overlay may still have mapped is never mutated underneath it. Invalidation bumps
-- `gen`, which is part of every slot filename, so a new generation cannot collide
-- with files the old one left mapped.
local cache = {
    gen = 0,
    slots = {},          -- [idx] = path of a written slot file
    times = {},          -- [idx] = seek time the slot's frame was decoded for
    attempts = {},       -- [idx] = failed background attempts so far
    count = 0,
    interval = 0,
    w = nil, h = nil,    -- dimensions the slots were rendered at
    next_idx = 1,        -- round-robin cursor for the background pass
    pending = nil,       -- slot the background pass is currently waiting on
    deadline = nil,      -- when to give up on `pending`
    started_at = nil,    -- when the fetch for `pending` was issued, for pacing
    next_allowed = nil,  -- bandwidth pacing: no background fetch before this time
    swallow_until = nil, -- drop one stray frame from an abandoned background seek
    start_after = nil,   -- background pass may not start before this time
    complete = false
}

-- The seek time the frame currently sitting in <thumbnail>.bgra was produced for,
-- and the source path currently on the overlay (so identical redraws are skipped).
local current_frame_time
local displayed_source
local last_interaction = 0

local filters_reset = {["lavfi-crop"]=true, ["crop"]=true}
local filters_runtime = {["hflip"]=true, ["vflip"]=true}
local filters_all = {["hflip"]=true, ["vflip"]=true, ["lavfi-crop"]=true, ["crop"]=true}

local tone_mappings = {["none"]=true, ["clip"]=true, ["linear"]=true, ["gamma"]=true, ["reinhard"]=true, ["hable"]=true, ["mobius"]=true}
local last_tone_mapping

local last_vf_reset = ""
local last_vf_runtime = ""

local last_rotate = 0

local par = ""
local last_par = ""

local last_crop = nil

local last_has_vid = 0
local has_vid = 0

local file_timer
local file_check_period = 1/60

local allow_fast_seek = true

local client_script = [=[
#!/usr/bin/env bash
MPV_IPC_FD=0; MPV_IPC_PATH="%s"
trap "kill 0" EXIT
while [[ $# -ne 0 ]]; do case $1 in --mpv-ipc-fd=*) MPV_IPC_FD=${1/--mpv-ipc-fd=/} ;; esac; shift; done
if echo "print-text thumbfast" >&"$MPV_IPC_FD"; then echo -n > "$MPV_IPC_PATH"; tail -f "$MPV_IPC_PATH" >&"$MPV_IPC_FD" & while read -r -u "$MPV_IPC_FD" 2>/dev/null; do :; done; fi
]=]

local function get_os()
    local raw_os_name = ""

    if jit and jit.os and jit.arch then
        raw_os_name = jit.os
    else
        if package.config:sub(1,1) == "\\" then
            -- Windows
            local env_OS = os.getenv("OS")
            if env_OS then
                raw_os_name = env_OS
            end
        else
            raw_os_name = subprocess({"uname", "-s"}).stdout
        end
    end

    raw_os_name = (raw_os_name):lower()

    local os_patterns = {
        ["windows"] = "windows",
        ["linux"]   = "linux",

        ["osx"]     = "darwin",
        ["mac"]     = "darwin",
        ["darwin"]  = "darwin",

        ["^mingw"]  = "windows",
        ["^cygwin"] = "windows",

        ["bsd$"]    = "darwin",
        ["sunos"]   = "darwin"
    }

    -- Default to linux
    local str_os_name = "linux"

    for pattern, name in pairs(os_patterns) do
        if raw_os_name:match(pattern) then
            str_os_name = name
            break
        end
    end

    return str_os_name
end

local os_name = mp.get_property("platform") or get_os()

local path_separator = os_name == "windows" and "\\" or "/"

if options.socket == "" then
    if os_name == "windows" then
        options.socket = "thumbfast"
    else
        options.socket = "/tmp/thumbfast"
    end
end

if options.thumbnail == "" then
    if os_name == "windows" then
        options.thumbnail = os.getenv("TEMP").."\\thumbfast.out"
    else
        options.thumbnail = "/tmp/thumbfast.out"
    end
end

local unique = mp.utils.getpid()

options.socket = options.socket .. unique
options.thumbnail = options.thumbnail .. unique

if options.direct_io then
    if os_name == "windows" then
        winapi.socket_wc = winapi.MultiByteToWideChar("\\\\.\\pipe\\" .. options.socket)
    end

    if winapi.socket_wc == "" then
        options.direct_io = false
    end
end

options.scale_factor = math.floor(options.scale_factor)

local mpv_path = options.mpv_path
local frontend_path

if mpv_path == "mpv" and os_name == "windows" then
    frontend_path = mp.get_property_native("user-data/frontend/process-path")
    mpv_path = frontend_path or mpv_path
end

if mpv_path == "mpv" and os_name == "darwin" and unique then
    -- TODO: look into ~~osxbundle/
    mpv_path = string.gsub(subprocess({"ps", "-o", "comm=", "-p", tostring(unique)}).stdout, "[\n\r]", "")
    if mpv_path ~= "mpv" then
        mpv_path = string.gsub(mpv_path, "/mpv%-bundle$", "/mpv")
        local mpv_bin = mp.utils.file_info("/usr/local/mpv")
        if mpv_bin and mpv_bin.is_file then
            mpv_path = "/usr/local/mpv"
        else
            local mpv_app = mp.utils.file_info("/Applications/mpv.app/Contents/MacOS/mpv")
            if mpv_app and mpv_app.is_file then
                mp.msg.warn("symlink mpv to fix Dock icons: `sudo ln -s /Applications/mpv.app/Contents/MacOS/mpv /usr/local/mpv`")
            else
                mp.msg.warn("drag to your Applications folder and symlink mpv to fix Dock icons: `sudo ln -s /Applications/mpv.app/Contents/MacOS/mpv /usr/local/mpv`")
            end
        end
    end
end

local function vo_tone_mapping()
    local passes = mp.get_property_native("vo-passes")
    if passes and passes["fresh"] then
        for k, v in pairs(passes["fresh"]) do
            for k2, v2 in pairs(v) do
                if k2 == "desc" and v2 then
                    local tone_mapping = string.match(v2, "([0-9a-z.-]+) tone map")
                    if tone_mapping then
                        return tone_mapping
                    end
                end
            end
        end
    end
end

local function vf_string(filters, full)
    local vf = ""
    local vf_table = properties["vf"]

    if (properties["video-crop"] or "") ~= "" then
        vf = "lavfi-crop="..string.gsub(properties["video-crop"], "(%d*)x?(%d*)%+(%d+)%+(%d+)", "w=%1:h=%2:x=%3:y=%4")..","
        local width = properties["video-out-params"] and properties["video-out-params"]["dw"]
        local height = properties["video-out-params"] and properties["video-out-params"]["dh"]
        if width and height then
            vf = string.gsub(vf, "w=:h=:", "w="..width..":h="..height..":")
        end
    end

    if vf_table and #vf_table > 0 then
        for i = #vf_table, 1, -1 do
            if filters[vf_table[i].name] then
                local args = ""
                for key, value in pairs(vf_table[i].params) do
                    if args ~= "" then
                        args = args .. ":"
                    end
                    args = args .. key .. "=" .. value
                end
                vf = vf .. vf_table[i].name .. "=" .. args .. ","
            end
        end
    end

    if (full and options.tone_mapping ~= "no") or options.tone_mapping == "auto" then
        if properties["video-params"] and properties["video-params"]["primaries"] == "bt.2020" then
            local tone_mapping = options.tone_mapping
            if tone_mapping == "auto" then
                tone_mapping = last_tone_mapping or properties["tone-mapping"]
                if tone_mapping == "auto" and properties["current-vo"] == "gpu-next" then
                    tone_mapping = vo_tone_mapping()
                end
            end
            if not tone_mappings[tone_mapping] then
                tone_mapping = "hable"
            end
            last_tone_mapping = tone_mapping
            vf = vf .. "zscale=transfer=linear,format=gbrpf32le,tonemap="..tone_mapping..",zscale=transfer=bt709,"
        end
    end

    if full then
        vf = vf.."scale=w="..effective_w..":h="..effective_h..par..",pad=w="..effective_w..":h="..effective_h..":x=-1:y=-1,format=bgra"
    end

    return vf
end

local function calc_dimensions()
    local width = properties["video-out-params"] and properties["video-out-params"]["dw"]
    local height = properties["video-out-params"] and properties["video-out-params"]["dh"]
    if not width or not height then return end

    local scale = properties["display-hidpi-scale"] or 1

    if width / height > options.max_width / options.max_height then
        effective_w = math.floor(options.max_width * scale + 0.5)
        effective_h = math.floor(height / width * effective_w + 0.5)
    else
        effective_h = math.floor(options.max_height * scale + 0.5)
        effective_w = math.floor(width / height * effective_h + 0.5)
    end

    local v_par = properties["video-out-params"] and properties["video-out-params"]["par"] or 1
    if v_par == 1 then
        par = ":force_original_aspect_ratio=decrease"
    else
        par = ""
    end
end

local info_timer = nil

local function info(w, h)
    local rotate = properties["video-params"] and properties["video-params"]["rotate"]
    local image = properties["current-tracks/video"] and properties["current-tracks/video"]["image"]
    local albumart = image and properties["current-tracks/video"]["albumart"]

    disabled = (w or 0) == 0 or (h or 0) == 0 or
        has_vid == 0 or
        (properties["demuxer-via-network"] and not options.network) or
        (albumart and not options.audio) or
        (image and not albumart) or
        force_disabled

    if info_timer then
        info_timer:kill()
        info_timer = nil
    elseif has_vid == 0 or (rotate == nil and not disabled) then
        info_timer = mp.add_timeout(0.05, function() info(w, h) end)
    end

    local json, err = mp.utils.format_json({width=w * options.scale_factor, height=h * options.scale_factor, scale_factor=options.scale_factor, disabled=disabled, available=true, socket=options.socket, thumbnail=options.thumbnail, overlay_id=options.overlay_id})
    if pre_0_30_0 then
        mp.command_native({"script-message", "thumbfast-info", json})
    else
        mp.command_native_async({"script-message", "thumbfast-info", json}, function() end)
    end
end

local function remove_thumbnail_files()
    if file then
        file:close()
        file = nil
        file_bytes = 0
    end
    os.remove(options.thumbnail)
    os.remove(options.thumbnail..".bgra")
end

local activity_timer

local function spawn(time)
    if disabled then return end

    local path = properties["path"]
    if path == nil then return end

    if options.quit_after_inactivity > 0 then
        if show_thumbnail or activity_timer:is_enabled() then
            activity_timer:kill()
        end
        activity_timer:resume()
    end

    local open_filename = properties["stream-open-filename"]
    local ytdl = open_filename and properties["demuxer-via-network"] and path ~= open_filename
    if ytdl then
        path = open_filename
    end

    remove_thumbnail_files()

    local vid = properties["vid"]
    has_vid = vid or 0

    local args = {
        mpv_path, "--no-config", "--msg-level=all=no", "--idle", "--pause", "--keep-open=always", "--really-quiet", "--no-terminal",
        "--load-scripts=no", "--osc=no", "--ytdl=no", "--load-stats-overlay=no", "--load-osd-console=no", "--load-auto-profiles=no",
        "--edition="..(properties["edition"] or "auto"), "--vid="..(vid or "auto"), "--no-sub", "--no-audio",
        "--start="..time, allow_fast_seek and "--hr-seek=no" or "--hr-seek=yes",
        "--ytdl-format=worst", "--demuxer-readahead-secs=0", "--demuxer-max-bytes=128KiB",
        "--vd-lavc-skiploopfilter=all", "--vd-lavc-software-fallback=1", "--vd-lavc-fast", "--vd-lavc-threads=2", "--hwdec="..(options.hwdec and "auto" or "no"),
        "--vf="..vf_string(filters_all, true),
        "--sws-scaler=fast-bilinear",
        "--video-rotate="..last_rotate,
        "--ovc=rawvideo", "--of=image2", "--ofopts=update=1", "--o="..options.thumbnail
    }

    if not pre_0_30_0 then
        table.insert(args, "--sws-allow-zimg=no")
    end

    if support_media_control then
        table.insert(args, "--media-controls=no")
    end

    if os_name == "darwin" and properties["macos-app-activation-policy"] then
        table.insert(args, "--macos-app-activation-policy=accessory")
    end

    if os_name == "windows" or pre_0_33_0 then
        table.insert(args, "--input-ipc-server="..options.socket)
    elseif not script_written then
        local client_script_path = options.socket..".run"
        local script = io.open(client_script_path, "w+")
        if script == nil then
            mp.msg.error("client script write failed")
            return
        else
            script_written = true
            script:write(string.format(client_script, options.socket))
            script:close()
            subprocess({"chmod", "+x", client_script_path}, true)
            table.insert(args, "--scripts="..client_script_path)
        end
    else
        local client_script_path = options.socket..".run"
        table.insert(args, "--scripts="..client_script_path)
    end

    table.insert(args, "--")
    table.insert(args, path)

    spawned = true
    spawn_waiting = true

    subprocess(args, true,
        function(success, result)
            if spawn_waiting and (success == false or (result.status ~= 0 and result.status ~= -2)) then
                spawned = false
                spawn_waiting = false
                options.tone_mapping = "no"
                mp.msg.error("mpv subprocess create failed")
                if not spawn_working then -- notify users of required configuration
                    if options.mpv_path == "mpv" then
                        if properties["current-vo"] == "libmpv" then
                            if options.mpv_path == mpv_path then -- attempt to locate ImPlay
                                mpv_path = "ImPlay"
                                spawn(time)
                            else -- ImPlay not in path
                                if os_name ~= "darwin" then
                                    force_disabled = true
                                    info(real_w or effective_w, real_h or effective_h)
                                end
                                mp.commandv("show-text", "thumbfast: ERROR! cannot create mpv subprocess", 5000)
                                mp.commandv("script-message-to", "implay", "show-message", "thumbfast initial setup", "Set mpv_path=PATH_TO_ImPlay in thumbfast config:\n" .. string.gsub(mp.command_native({"expand-path", "~~/script-opts/thumbfast.conf"}), "[/\\]", path_separator).."\nand restart ImPlay")
                            end
                        else
                            mp.commandv("show-text", "thumbfast: ERROR! cannot create mpv subprocess", 5000)
                            if os_name == "windows" and frontend_path == nil then
                                mp.commandv("script-message-to", "mpvnet", "show-text", "thumbfast: ERROR! install standalone mpv, see README", 5000, 20)
                                mp.commandv("script-message", "mpv.net", "show-text", "thumbfast: ERROR! install standalone mpv, see README", 5000, 20)
                            end
                        end
                    else
                        mp.commandv("show-text", "thumbfast: ERROR! cannot create mpv subprocess", 5000)
                        -- found ImPlay but not defined in config
                        mp.commandv("script-message-to", "implay", "show-message", "thumbfast", "Set mpv_path=PATH_TO_ImPlay in thumbfast config:\n" .. string.gsub(mp.command_native({"expand-path", "~~/script-opts/thumbfast.conf"}), "[/\\]", path_separator).."\nand restart ImPlay")
                    end
                end
            elseif success == true and (result.status == 0 or result.status == -2) then
                if not spawn_working and properties["current-vo"] == "libmpv" and options.mpv_path ~= mpv_path then
                    mp.commandv("script-message-to", "implay", "show-message", "thumbfast initial setup", "Set mpv_path=ImPlay in thumbfast config:\n" .. string.gsub(mp.command_native({"expand-path", "~~/script-opts/thumbfast.conf"}), "[/\\]", path_separator).."\nand restart ImPlay")
                end
                spawn_working = true
                spawn_waiting = false
            end
        end
    )
end

local function run(command)
    if not spawned then return end

    if options.direct_io then
        local hPipe = winapi.C.CreateFileW(winapi.socket_wc, winapi.GENERIC_WRITE, 0, nil, winapi.OPEN_EXISTING, winapi._createfile_pipe_flags, nil)
        if hPipe ~= winapi.INVALID_HANDLE_VALUE then
            local buf = command .. "\n"
            winapi.C.SetNamedPipeHandleState(hPipe, winapi.PIPE_NOWAIT, nil, nil)
            winapi.C.WriteFile(hPipe, buf, #buf + 1, winapi._lpNumberOfBytesWritten, nil)
            winapi.C.CloseHandle(hPipe)
        end

        return
    end

    local command_n = command.."\n"

    if os_name == "windows" then
        if file and file_bytes + #command_n >= 4096 then
            file:close()
            file = nil
            file_bytes = 0
        end
        if not file then
            file = io.open("\\\\.\\pipe\\"..options.socket, "r+b")
        end
    elseif pre_0_33_0 then
        subprocess({"/usr/bin/env", "sh", "-c", "echo '" .. command .. "' | socat - " .. options.socket})
        return
    elseif not file then
        file = io.open(options.socket, "r+")
    end
    if file then
        file_bytes = file:seek("end")
        file:write(command_n)
        file:flush()
    end
end

-- Timeline thumbnail cache: storage layer (fork addition) --------------------

local function cache_slot_path(idx)
    return options.thumbnail..".c"..cache.gen.."."..idx..".bgra"
end

-- Best effort: a slot the overlay still has mapped cannot be deleted on Windows.
-- That is why the generation counter is part of the filename -- a leftover file is
-- never reused, only orphaned, and gets swept on the next load or on shutdown.
local function cache_purge()
    for _, path in pairs(cache.slots) do
        os.remove(path)
        os.remove(path..".tmp")
    end
end

local function cache_reset()
    cache_purge()
    cache.gen = cache.gen + 1
    cache.slots = {}
    cache.times = {}
    cache.attempts = {}
    cache.next_idx = 1
    cache.pending = nil
    cache.deadline = nil
    cache.started_at = nil
    cache.next_allowed = nil
    cache.swallow_until = nil
    cache.complete = false
    cache.w, cache.h = nil, nil
end

local function cache_plan()
    if not options.cache_enabled then return false end
    local duration = mp.get_property_number("duration")
    if not duration or duration <= 0 then
        cache.count = 0
        return false
    end
    cache.count = math.max(2, math.min(200, math.floor(options.cache_thumbnails)))
    cache.interval = duration / cache.count
    return true
end

-- Slot idx covers [cache_time(idx), cache_time(idx) + interval), and holds the frame
-- at its start, so the fallback shown for a hover is always at or before that hover.
local function cache_time(idx)
    if idx <= 1 then return math.min(1, cache.interval * 0.5) end
    return (idx - 1) * cache.interval
end

local function cache_index(time)
    if not time or cache.count == 0 or cache.interval <= 0 then return nil end
    local idx = math.floor(time / cache.interval) + 1
    if idx < 1 then return 1 end
    if idx > cache.count then return cache.count end
    return idx
end

-- Copies whatever is in <thumbnail>.bgra right now into slot idx. Filled slots are
-- never rewritten: a placeholder gains nothing from being refreshed, and leaving the
-- file untouched keeps it safe to hand to overlay-add at any time.
local function cache_store(idx, time)
    if not options.cache_enabled or not idx or not time or not real_w or not real_h then return end
    if cache.slots[idx] then return end
    if cache.w and (cache.w ~= real_w or cache.h ~= real_h) then
        cache_reset()
        return
    end

    local src = io.open(options.thumbnail..".bgra", "rb")
    if not src then return end
    local data = src:read("*a")
    src:close()
    if not data or #data ~= real_w * real_h * 4 then return end

    local path = cache_slot_path(idx)
    local tmp = path..".tmp"
    local dst = io.open(tmp, "wb")
    if not dst then return end
    dst:write(data)
    dst:close()
    os.rename(tmp, path)

    cache.w, cache.h = real_w, real_h
    cache.slots[idx] = path
    cache.times[idx] = time
    cache.complete = false
end

-- Nearest filled slot to `time`, preferring the one before it. Returns path, distance.
local function cache_nearest(time)
    local idx = cache_index(time)
    if not idx then return nil end
    if cache.slots[idx] then return cache.slots[idx], math.abs(time - cache.times[idx]) end
    for d = 1, cache.count do
        local before, after = idx - d, idx + d
        if before >= 1 and cache.slots[before] then
            return cache.slots[before], math.abs(time - cache.times[before])
        end
        if after <= cache.count and cache.slots[after] then
            return cache.slots[after], math.abs(time - cache.times[after])
        end
    end
    return nil
end

local function stream_mbps()
    local v = mp.get_property_number("video-bitrate")
    if v and v > 0 then
        return (v + (mp.get_property_number("audio-bitrate") or 0)) / 1000000
    end
    local size = mp.get_property_number("file-size")
    local duration = mp.get_property_number("duration")
    if size and duration and duration > 0 then
        return size * 8 / duration / 1000000
    end
    return nil
end

-- mpv cannot rate-limit a download, so the budget is enforced by pacing: a fetch
-- that occupied the link for `elapsed` seconds is followed by a wait long enough
-- that the pass only takes its configured share of a link carrying this stream.
local function cache_pace(elapsed)
    local budget = options.cache_bandwidth_mbps
    if not budget or budget <= 0 or not elapsed or elapsed <= 0 then
        cache.next_allowed = nil
        return
    end
    -- Unknown bitrate: assume something middling rather than running wide open.
    local mbps = stream_mbps() or 8
    local share = budget / math.max(budget, mbps)
    local wait = math.min(120, elapsed * (1 / share - 1))
    cache.next_allowed = mp.get_time() + wait
end

-- Prebuilding must never starve playback, so it only runs while the player itself
-- has buffer to spare. Local files report no cache duration and are always fine.
local function cache_has_headroom()
    if not properties["demuxer-via-network"] then return true end
    local buffering = mp.get_property_number("cache-buffering-state")
    if buffering and buffering < 100 then return false end
    local buffered = mp.get_property_number("demuxer-cache-duration")
    if buffered and buffered < options.cache_min_buffer_secs then return false end
    return true
end

-- What to put on screen for a hover at `time`: the live frame if it was decoded for
-- (near enough) this time, otherwise whichever of the live frame and the nearest
-- cached frame is closer to it.
local function pick_source(time)
    local live = options.thumbnail..".bgra"
    if not options.cache_enabled then return live end
    -- Slots hold cache.w x cache.h pixels. overlay-add is told to read w*h*4 bytes
    -- from whatever file it is given, so serving a slot after the thumbnail size
    -- changed would read past the end of the mapping and fault the player.
    if cache.w ~= real_w or cache.h ~= real_h then return live end
    local live_dist = math.huge
    if current_frame_time then live_dist = math.abs(current_frame_time - time) end
    if live_dist < 0.5 then return live end
    local cached, cached_dist = cache_nearest(time)
    if cached and cached_dist < live_dist then return cached end
    return live
end

-- ----------------------------------------------------------------------------

local function draw(w, h, script, source)
    if not w or not show_thumbnail then return end
    source = source or (options.thumbnail..".bgra")
    displayed_source = source
    if x ~= nil then
        local scale_w, scale_h = options.scale_factor ~= 1 and (w * options.scale_factor) or nil, options.scale_factor ~= 1 and (h * options.scale_factor) or nil
        if pre_0_30_0 then
            mp.command_native({"overlay-add", options.overlay_id, x, y, source, 0, "bgra", w, h, (4*w), scale_w, scale_h})
        else
            mp.command_native_async({"overlay-add", options.overlay_id, x, y, source, 0, "bgra", w, h, (4*w), scale_w, scale_h}, function() end)
        end
    elseif script then
        -- Consumers append ".bgra" to `thumbnail` themselves, so hand them the cache
        -- slot with that suffix trimmed back off.
        local base = string.gsub(source, "%.bgra$", "")
        local json, err = mp.utils.format_json({width=w, height=h, scale_factor=options.scale_factor, x=x, y=y, socket=options.socket, thumbnail=base, overlay_id=options.overlay_id})
        mp.commandv("script-message-to", script, "thumbfast-render", json)
    end
end

local function real_res(req_w, req_h, filesize)
    local count = filesize / 4
    local diff = (req_w * req_h) - count

    if (properties["video-params"] and properties["video-params"]["rotate"] or 0) % 180 == 90 then
        req_w, req_h = req_h, req_w
    end

    if diff == 0 then
        return req_w, req_h
    else
        local threshold = 5 -- throw out results that change too much
        local long_side, short_side = req_w, req_h
        if req_h > req_w then
            long_side, short_side = req_h, req_w
        end
        for a = short_side, short_side - threshold, -1 do
            if count % a == 0 then
                local b = count / a
                if long_side - b < threshold then
                    if req_h < req_w then return b, a else return a, b end
                end
            end
        end
        return nil
    end
end

local function move_file(from, to)
    if os_name == "windows" then
        os.remove(to)
    end
    -- move the file because it can get overwritten while overlay-add is reading it, and crash the player
    os.rename(from, to)
end

local function seek(fast)
    if last_seek_time then
        run("async seek " .. last_seek_time .. (fast and " absolute+keyframes" or " absolute+exact"))
    end
end

local seek_period = 3/60
local seek_period_counter = 0
local seek_timer
seek_timer = mp.add_periodic_timer(seek_period, function()
    if seek_period_counter == 0 then
        seek(allow_fast_seek)
        seek_period_counter = 1
    else
        if seek_period_counter == 2 then
            if allow_fast_seek then
                seek_timer:kill()
                seek()
            end
        else seek_period_counter = seek_period_counter + 1 end
    end
end)
seek_timer:kill()

local function request_seek()
    if seek_timer:is_enabled() then
        seek_period_counter = 0
    else
        seek_timer:resume()
        seek(allow_fast_seek)
        seek_period_counter = 1
    end
end

local function check_new_thumb()
    -- the slave might start writing to the file after checking existance and
    -- validity but before actually moving the file, so move to a temporary
    -- location before validity check to make sure everything stays consistant
    -- and valid thumbnails don't get overwritten by invalid ones
    local tmp = options.thumbnail..".tmp"
    move_file(options.thumbnail, tmp)
    local finfo = mp.utils.file_info(tmp)
    if not finfo then return false end
    spawn_waiting = false
    local w, h = real_res(effective_w, effective_h, finfo.size)
    if w then -- only accept valid thumbnails
        move_file(tmp, options.thumbnail..".bgra")

        real_w, real_h = w, h
        if real_w and (real_w ~= last_real_w or real_h ~= last_real_h) then
            last_real_w, last_real_h = real_w, real_h
            info(real_w, real_h)
        end
        if not show_thumbnail then
            file_timer:kill()
        end
        return true
    end

    return false
end

file_timer = mp.add_periodic_timer(file_check_period, function()
    if not check_new_thumb() then return end

    -- A frame the background pass asked for belongs to an unrelated point on the
    -- timeline, so it goes straight to its slot and never to the screen.
    if cache.pending and not show_thumbnail then
        cache_store(cache.pending, cache_time(cache.pending))
        cache_pace(cache.started_at and (mp.get_time() - cache.started_at) or nil)
        cache.pending = nil
        cache.deadline = nil
        cache.started_at = nil
        return
    end

    -- One frame from a background seek that was abandoned mid-flight when the user
    -- started hovering. It cannot be attributed to either request, so drop it: the
    -- cached placeholder stays up until the real frame for this hover arrives.
    if cache.swallow_until then
        if mp.get_time() < cache.swallow_until then
            cache.swallow_until = nil
            return
        end
        cache.swallow_until = nil
    end

    current_frame_time = last_seek_time
    cache_store(cache_index(last_seek_time), last_seek_time)
    draw(real_w, real_h, script_name)
end)
file_timer:kill()

-- Timeline thumbnail cache: background pass (fork addition) -------------------

local cache_timer

local function cache_next_slot()
    for i = 0, cache.count - 1 do
        local idx = ((cache.next_idx - 1 + i) % cache.count) + 1
        if not cache.slots[idx] and (cache.attempts[idx] or 0) < options.cache_attempts then
            return idx
        end
    end
    return nil
end

local function cache_tick()
    if not options.cache_enabled or disabled or force_disabled then return end
    if cache.count == 0 and not cache_plan() then return end

    local now = mp.get_time()

    if cache.pending then
        if cache.deadline and now > cache.deadline then
            -- the thumbnailer never produced this one, most likely a stalled read on
            -- a region the stream has not fetched yet; charge the slot and move on.
            -- It still occupied the link for that whole time, so it still gets paced.
            cache.attempts[cache.pending] = (cache.attempts[cache.pending] or 0) + 1
            cache_pace(cache.started_at and (now - cache.started_at) or nil)
            cache.pending = nil
            cache.deadline = nil
            cache.started_at = nil
        end
        return
    end

    -- Hovering owns the thumbnailer; the background pass only runs in the gaps.
    if show_thumbnail or now < last_interaction + options.cache_idle_delay then return end
    if cache.start_after and now < cache.start_after then return end
    -- Stay inside the bandwidth budget, and back off entirely while playback is
    -- short of buffer -- a 4K stream needs the link far more than previews do.
    if cache.next_allowed and now < cache.next_allowed then return end
    if not cache_has_headroom() then return end

    local idx = cache_next_slot()
    if not idx then
        cache.complete = true
        cache_timer:kill()
        return
    end

    cache.next_idx = (idx % cache.count) + 1
    cache.pending = idx
    cache.deadline = now + options.cache_timeout
    cache.started_at = now

    if not spawned then
        spawn(cache_time(idx))
    else
        run("async seek "..cache_time(idx).." absolute+keyframes")
    end
    if not file_timer:is_enabled() then file_timer:resume() end
end

cache_timer = mp.add_periodic_timer(0.25, cache_tick)
cache_timer:kill()

local function cache_start()
    if not options.cache_enabled or disabled or force_disabled then return end

    local old_count, old_interval = cache.count, cache.interval
    if not cache_plan() then return end
    if old_count ~= 0 and (old_count ~= cache.count or math.abs(old_interval - cache.interval) > 0.001) then
        -- the timeline was laid out again underneath the existing slots
        cache_reset()
    end

    if not cache_timer:is_enabled() then
        cache.start_after = mp.get_time() + options.cache_prebuild_delay
        cache_timer:resume()
    end
end

local function clear()
    file_timer:kill()
    seek_timer:kill()
    if options.quit_after_inactivity > 0 then
        if show_thumbnail or activity_timer:is_enabled() then
            activity_timer:kill()
        end
        activity_timer:resume()
    end
    last_seek_time = nil
    show_thumbnail = false
    last_x = nil
    last_y = nil
    displayed_source = nil
    last_interaction = mp.get_time()
    -- hovering is over, let the background pass fill whatever is still missing
    if options.cache_enabled and not cache.complete and not cache_timer:is_enabled() then
        cache_timer:resume()
    end
    if script_name then return end
    if pre_0_30_0 then
        mp.command_native({"overlay-remove", options.overlay_id})
    else
        mp.command_native_async({"overlay-remove", options.overlay_id}, function() end)
    end
end

local function quit()
    activity_timer:kill()
    if show_thumbnail then
        activity_timer:resume()
        return
    end
    run("quit")
    spawned = false
    real_w, real_h = nil, nil
    clear()
end

activity_timer = mp.add_timeout(options.quit_after_inactivity, quit)
activity_timer:kill()

local function thumb(time, r_x, r_y, script)
    if disabled then return end

    time = tonumber(time)
    if time == nil then return end

    if r_x == "" or r_y == "" then
        x, y = nil, nil
    else
        x, y = math.floor(r_x + 0.5), math.floor(r_y + 0.5)
    end

    last_interaction = mp.get_time()

    -- Whatever the background pass has in flight can no longer be attributed once an
    -- interactive seek is queued behind it, so abandon the slot (it gets retried on a
    -- later pass) and arrange for its stray frame to be dropped rather than shown.
    if cache.pending then
        cache_pace(cache.started_at and (last_interaction - cache.started_at) or nil)
        cache.pending = nil
        cache.deadline = nil
        cache.started_at = nil
        cache.swallow_until = last_interaction + 1.5
    end

    script_name = script
    -- Put something on screen straight away: the nearest cached frame, unless the
    -- live one happens to be closer to this hover. The exact frame replaces it as
    -- soon as the thumbnailer produces it.
    local source = pick_source(time)
    if last_x ~= x or last_y ~= y or not show_thumbnail or source ~= displayed_source then
        show_thumbnail = true
        last_x, last_y = x, y
        draw(real_w, real_h, script, source)
    end

    if options.quit_after_inactivity > 0 then
        if show_thumbnail or activity_timer:is_enabled() then
            activity_timer:kill()
        end
        activity_timer:resume()
    end

    if time == last_seek_time then return end
    last_seek_time = time
    if not spawned then spawn(time) end
    request_seek()
    if not file_timer:is_enabled() then file_timer:resume() end
end

local function watch_changes()
    if not dirty or not properties["video-out-params"] then return end
    dirty = false

    local old_w = effective_w
    local old_h = effective_h

    calc_dimensions()

    local vf_reset = vf_string(filters_reset)
    local rotate = properties["video-rotate"] or 0

    local resized = old_w ~= effective_w or
        old_h ~= effective_h or
        last_vf_reset ~= vf_reset or
        (last_rotate % 180) ~= (rotate % 180) or
        par ~= last_par or last_crop ~= properties["video-crop"]

    if resized then
        last_rotate = rotate
        info(effective_w, effective_h)
    elseif last_has_vid ~= has_vid and has_vid ~= 0 then
        info(effective_w, effective_h)
    end

    if spawned then
        if resized then
            -- mpv doesn't allow us to change output size
            local seek_time = last_seek_time
            run("quit")
            clear()
            spawned = false
            spawn(seek_time or mp.get_property_number("time-pos", 0))
            file_timer:resume()
        else
            if rotate ~= last_rotate then
                run("set video-rotate "..rotate)
            end
            local vf_runtime = vf_string(filters_runtime)
            if vf_runtime ~= last_vf_runtime then
                run("vf set "..vf_string(filters_all, true))
                last_vf_runtime = vf_runtime
            end
        end
    else
        last_vf_runtime = vf_string(filters_runtime)
    end

    last_vf_reset = vf_reset
    last_rotate = rotate
    last_par = par
    last_crop = properties["video-crop"]
    last_has_vid = has_vid

    if resized then
        -- Cached frames were rendered at the old size, so none of them can be
        -- reused. Deliberately after the clear() above: slot files are only deleted
        -- once the overlay that might still be showing one has been removed.
        cache_reset()
        cache_start()
    end

    if not spawned and not disabled and options.spawn_first and resized then
        spawn(mp.get_property_number("time-pos", 0))
        file_timer:resume()
    end
end

local function update_property(name, value)
    properties[name] = value
end

local function update_property_dirty(name, value)
    properties[name] = value
    dirty = true
    if name == "tone-mapping" then
        last_tone_mapping = nil
    end
end

local function update_tracklist(name, value)
    -- current-tracks shim
    for _, track in ipairs(value) do
        if track.type == "video" and track.selected then
            properties["current-tracks/video"] = track
            return
        end
    end
end

local function sync_changes(prop, val)
    update_property(prop, val)
    if val == nil then return end

    if type(val) == "boolean" then
        if prop == "vid" then
            has_vid = 0
            last_has_vid = 0
            info(effective_w, effective_h)
            clear()
            return
        end
        val = val and "yes" or "no"
    end

    if prop == "vid" then
        has_vid = 1
    end

    if not spawned then return end

    run("set "..prop.." "..val)
    dirty = true
end

local function file_load()
    clear()
    spawned = false
    real_w, real_h = nil, nil
    last_real_w, last_real_h = nil, nil
    last_tone_mapping = nil
    last_seek_time = nil
    current_frame_time = nil
    cache_reset()
    if info_timer then
        info_timer:kill()
        info_timer = nil
    end

    calc_dimensions()
    info(effective_w, effective_h)
    cache_start()
end

local function shutdown()
    run("quit")
    remove_thumbnail_files()
    cache_purge()
    if os_name ~= "windows" then
        os.remove(options.socket)
        os.remove(options.socket..".run")
    end
end

local function on_duration(prop, val)
    allow_fast_seek = (val or 30) >= 30
    -- duration is usually only known a moment after file-loaded, and the cache
    -- cannot be laid out without it
    cache_start()
end

mp.observe_property("current-tracks/video", "native", function(name, value)
    if pre_0_33_0 then
        mp.unobserve_property(update_tracklist)
        pre_0_33_0 = false
    end
    update_property(name, value)
end)

mp.observe_property("track-list", "native", update_tracklist)
mp.observe_property("display-hidpi-scale", "native", update_property_dirty)
mp.observe_property("video-out-params", "native", update_property_dirty)
mp.observe_property("video-params", "native", update_property_dirty)
mp.observe_property("vf", "native", update_property_dirty)
mp.observe_property("tone-mapping", "native", update_property_dirty)
mp.observe_property("demuxer-via-network", "native", update_property)
mp.observe_property("stream-open-filename", "native", update_property)
mp.observe_property("macos-app-activation-policy", "native", update_property)
mp.observe_property("current-vo", "native", update_property)
mp.observe_property("video-rotate", "native", update_property)
mp.observe_property("video-crop", "native", update_property)
mp.observe_property("path", "native", update_property)
mp.observe_property("vid", "native", sync_changes)
mp.observe_property("edition", "native", sync_changes)
mp.observe_property("duration", "native", on_duration)

mp.register_script_message("thumb", thumb)
mp.register_script_message("clear", clear)

mp.register_event("file-loaded", file_load)
mp.register_event("shutdown", shutdown)

mp.register_idle(watch_changes)
