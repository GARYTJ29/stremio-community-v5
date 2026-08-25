#include "player.h"
#include <iostream>
#include <cctype>
#include <cstring>
#include <mutex>
#include <shared_mutex>
#include "../core/globals.h"
#include "../utils/crashlog.h"
#include "../utils/helpers.h"
#include "../ui/mainwindow.h"

// Guards g_mpv against CleanupMPV() destroying it while a detached command thread
// is still using the handle -- libmpv requires mpv_terminate_destroy() never run
// concurrently with another thread on the same handle.
static std::shared_mutex g_mpvMutex;

// Helper for mpv node => JSON
static nlohmann::json mpvNodeToJson(const mpv_node* node);

// Cache for chapters
static nlohmann::json g_cachedChapterList = nullptr;
static nlohmann::json g_cachedChapterIdx = -1;
static double g_cachedDuration = 0.0;

void ResendChapterData() {
    if (g_cachedChapterList.is_array()) {
        nlohmann::json j;
        j["type"] = "mpv-prop-change";
        j["name"] = "chapter-list";
        j["data"] = g_cachedChapterList;
        SendToJS("mpv-prop-change", j);
    }
    if (g_cachedChapterIdx.is_number()) {
        nlohmann::json j;
        j["type"] = "mpv-prop-change";
        j["name"] = "chapter";
        j["data"] = g_cachedChapterIdx;
        SendToJS("mpv-prop-change", j);
    }
    if (g_cachedDuration > 0) {
        nlohmann::json j;
        j["type"] = "mpv-prop-change";
        j["name"] = "duration";
        j["data"] = g_cachedDuration;
        SendToJS("mpv-prop-change", j);
    }
}

static nlohmann::json mpvNodeArrayToJson(const mpv_node_list* list)
{
    using json = nlohmann::json;
    json j = json::array();
    if(!list) return j;
    for(int i=0; i<list->num; i++){
        j.push_back(mpvNodeToJson(&list->values[i]));
    }
    return j;
}

static nlohmann::json mpvNodeMapToJson(const mpv_node_list* list)
{
    using json = nlohmann::json;
    json j = json::object();
    if(!list) return j;
    for(int i=0; i<list->num; i++){
        const char* key = (list->keys && list->keys[i]) ? list->keys[i] : "";
        mpv_node &val   = list->values[i];
        j[key] = mpvNodeToJson(&val);
    }
    return j;
}

static nlohmann::json mpvNodeToJson(const mpv_node* node)
{
    using json = nlohmann::json;
    if(!node) return nullptr;

    switch(node->format)
    {
    case MPV_FORMAT_STRING:
        return node->u.string ? node->u.string : "";
    case MPV_FORMAT_INT64:
        return (long long)node->u.int64;
    case MPV_FORMAT_DOUBLE:
        return node->u.double_;
    case MPV_FORMAT_FLAG:
        return (bool)node->u.flag;
    case MPV_FORMAT_NODE_ARRAY:
        return mpvNodeArrayToJson(node->u.list);
    case MPV_FORMAT_NODE_MAP:
        return mpvNodeMapToJson(node->u.list);
    default:
        return "<unhandled mpv_node format>";
    }
}

// Helper to properly capitalize mpv error
static std::string capitalizeFirstLetter(const std::string& input) {
    if (input.empty()) return input;
    std::string result = input;
    result[0] = std::toupper(result[0]);
    return result;
}

// Forward
static void MpvWakeup(void* ctx)
{
    PostMessage((HWND)ctx, WM_MPV_WAKEUP, 0, 0);
}

void HandleMpvEvents()
{
    if(!g_mpv) return;
    while(true){
        mpv_event* ev = mpv_wait_event(g_mpv, 0);
        if(!ev || ev->event_id==MPV_EVENT_NONE) break;

        if(ev->error<0) {
            std::cerr<<"mpv event error="<<mpv_error_string(ev->error)<<"\n";
        }

        switch(ev->event_id)
        {
        case MPV_EVENT_PROPERTY_CHANGE:
        {
            mpv_event_property* prop=(mpv_event_property*)ev->data;
            if(!prop||!prop->name)break;

            json j;
            j["type"] ="mpv-prop-change";
            j["id"]   =(int64_t)ev->reply_userdata;
            j["name"] = prop->name;
            if(ev->error<0)
                j["error"]=mpv_error_string(ev->error);

            switch(prop->format)
            {
                case MPV_FORMAT_INT64:
                    if(prop->data)
                        j["data"]=(long long)(*(int64_t*)prop->data);
                    else
                        j["data"]=nullptr;
                break;
                case MPV_FORMAT_DOUBLE:
                    if(prop->data)
                        j["data"]=*(double*)prop->data;
                    else
                        j["data"]=nullptr;
                break;
                case MPV_FORMAT_FLAG:
                    if(prop->data)
                        j["data"]=(*(int*)prop->data!=0);
                    else
                        j["data"]=false;
                break;
                case MPV_FORMAT_STRING:
                    if(prop->data){
                        const char*s=*(char**)prop->data;
                        j["data"]=(s? s:"");
                    } else {
                        j["data"]="";
                    }
                break;
                case MPV_FORMAT_NODE:
                    j["data"]=mpvNodeToJson((mpv_node*)prop->data);
                break;
                default:
                    j["data"]=nullptr;
                break;
            }
            if (j["name"] == "volume" && g_initialSet) {
                g_currentVolume = j["data"];
            }
            if (j["name"] == "chapter-list") {
                g_cachedChapterList = j["data"];
            }
            if (j["name"] == "chapter") {
                g_cachedChapterIdx = j["data"];
            }
            if (j["name"] == "duration") {
                g_cachedDuration = j["data"].is_number() ? j["data"].get<double>() : 0.0;
            }
            SendToJS("mpv-prop-change", j);
            break;
        }
        case MPV_EVENT_END_FILE:
        {
            mpv_event_end_file* ef=(mpv_event_end_file*)ev->data;
            nlohmann::json j;
            j["type"]="mpv-event-ended";
            switch(ef->reason){
                case MPV_END_FILE_REASON_EOF:
                    j["reason"]="quit";
                SendToJS("mpv-event-ended", j);
                break;
                case MPV_END_FILE_REASON_ERROR: {
                    std::string errorString = mpv_error_string(ef->error);
                    std::string capitalizedErrorString = capitalizeFirstLetter(errorString);
                    j["reason"]="error";
                    if(ef->error<0)
                        j["error"]= capitalizedErrorString;
                    SendToJS("mpv-event-ended", j);
                    AppendToCrashLog("[MPV]: " + capitalizedErrorString);
                    break;
                }
                default:
                    j["reason"]="other";
                break;
            }
            break;
        }
        case MPV_EVENT_SHUTDOWN:
        {
            std::cout<<"mpv EVENT_SHUTDOWN => terminate\n";
            std::unique_lock lock(g_mpvMutex);
            if(g_mpv){
                mpv_terminate_destroy(g_mpv);
                g_mpv=nullptr;
            }
            break;
        }
        default:
            // ignore
            break;
        }
    }
}

void HandleMpvCommand(const std::vector<std::string>& args)
{
    std::thread([args](){
        std::shared_lock lock(g_mpvMutex);
        if(!g_mpv || args.empty()) return;
        std::vector<const char*> cargs;
        for(auto &s: args) {
            cargs.push_back(s.c_str());
        }
        cargs.push_back(nullptr);
        mpv_command(g_mpv, cargs.data());
    }).detach();
}

void HandleMpvSetProp(const std::vector<std::string>& args)
{
    std::thread([args](){
        std::shared_lock lock(g_mpvMutex);
        if(!g_mpv || args.size()<2) return;
        std::string val=args[1];
        if(val=="true")  val="yes";
        if(val=="false") val="no";
        mpv_set_property_string(g_mpv, args[0].c_str(), val.c_str());
    }).detach();
}

void HandleMpvObserveProp(const std::vector<std::string>& args)
{
    std::thread([args](){
        std::shared_lock lock(g_mpvMutex);
        if(!g_mpv || args.empty()) return;
        std::string pname=args[0];
        g_observedProps.insert(pname);
        mpv_observe_property(g_mpv,0,pname.c_str(),MPV_FORMAT_NODE);
        std::cout<<"Observing prop="<<pname<<"\n";
    }).detach();
}

// ---------------------------------------------------------------------------
// Clipboard paste into mpv's console
//
// mpv's console binds ctrl+v to its own paste, but that binding is never
// reached here: the key is synthesised by the page-side console bridge (see
// webview.cpp), and what mpv ends up matching depends on the browser's
// event.key -- Caps Lock or Shift alone are enough to turn it into Ctrl+V,
// which console.lua does not bind, so the paste is dropped with "No key
// binding found". Reading the clipboard natively and typing it in one
// character at a time takes the browser's key naming and mpv's own clipboard
// backend out of the picture entirely.
// ---------------------------------------------------------------------------

// A URL or a command line is the point of this; anything longer is a misclick
// on a document, and every character costs an mpv_command plus a console
// redraw.
static const size_t kMaxPasteChars = 1024;

// CF_UNICODETEXT => UTF-8, empty on any failure.
static std::string GetClipboardUtf8()
{
    if(!IsClipboardFormatAvailable(CF_UNICODETEXT)) return {};

    // Another process can hold the clipboard open for a moment; a few retries
    // cost nothing and beat silently losing the paste.
    bool opened = false;
    for(int attempt=0; attempt<5 && !(opened = OpenClipboard(nullptr)); ++attempt)
        Sleep(20);
    if(!opened) return {};

    std::string out;
    if(HANDLE hData = GetClipboardData(CF_UNICODETEXT)){
        if(const wchar_t* wtext = (const wchar_t*)GlobalLock(hData)){
            int needed = WideCharToMultiByte(CP_UTF8,0,wtext,-1,nullptr,0,nullptr,nullptr);
            if(needed > 1){
                out.resize(needed-1);
                WideCharToMultiByte(CP_UTF8,0,wtext,-1,&out[0],needed,nullptr,nullptr);
            }
            GlobalUnlock(hData);
        }
    }
    CloseClipboard();
    return out;
}

// One mpv `keypress` name per character. mpv parses a bare UTF-8 character as
// itself, so only space needs the name mpv spells out for it. Newlines and
// tabs become spaces rather than ENTER/TAB, which in the console would submit
// the line or trigger completion halfway through a paste.
static std::vector<std::string> Utf8ToKeyNames(const std::string& text)
{
    std::vector<std::string> keys;
    size_t i = 0;
    while(i < text.size() && keys.size() < kMaxPasteChars){
        unsigned char lead = (unsigned char)text[i];

        size_t len = 1;
        if     ((lead & 0x80) == 0x00) len = 1;
        else if((lead & 0xE0) == 0xC0) len = 2;
        else if((lead & 0xF0) == 0xE0) len = 3;
        else if((lead & 0xF8) == 0xF0) len = 4;
        else { ++i; continue; }               // stray continuation byte

        if(i + len > text.size()) break;      // truncated sequence at the end
        bool valid = true;
        for(size_t k=1; k<len; ++k)
            if(((unsigned char)text[i+k] & 0xC0) != 0x80) valid = false;
        if(!valid){ ++i; continue; }

        if(len == 1){
            if(lead == '\r') { ++i; continue; }   // CRLF would otherwise double up
            if(lead == ' ' || lead == '\n' || lead == '\t')
                keys.push_back("SPACE");
            else if(lead >= 0x20 && lead != 0x7F)
                keys.push_back(std::string(1, (char)lead));
            // other control characters are dropped
        } else {
            keys.push_back(text.substr(i, len));
        }
        i += len;
    }
    return keys;
}

// mpv routes the console's key bindings only while the console is actually
// open - set_active(false) takes them away again. Typing a clipboard into a
// closed console would instead fire a few hundred arbitrary keys at mpv's
// normal bindings, where 'q' quits and 's' screenshots, so confirm the
// console owns the keyboard before sending anything. Its bindings are the
// only ones on the list owned by the console script, and there are ~70 of
// them while it is open against none while it is not.
static bool IsMpvConsoleOpen()
{
    mpv_node bindings;
    {
        std::shared_lock lock(g_mpvMutex);
        if(!g_mpv) return false;
        if(mpv_get_property(g_mpv, "input-bindings", MPV_FORMAT_NODE, &bindings) < 0)
            return false;
    }

    int consoleKeys = 0;
    if(bindings.format == MPV_FORMAT_NODE_ARRAY && bindings.u.list){
        for(int i=0; i<bindings.u.list->num; ++i){
            mpv_node& entry = bindings.u.list->values[i];
            if(entry.format != MPV_FORMAT_NODE_MAP || !entry.u.list) continue;

            std::string owner, section, key;
            for(int k=0; k<entry.u.list->num; ++k){
                const char* field = entry.u.list->keys ? entry.u.list->keys[k] : nullptr;
                mpv_node& val    = entry.u.list->values[k];
                if(!field || val.format != MPV_FORMAT_STRING || !val.u.string) continue;
                if     (!strcmp(field, "owner"))   owner   = val.u.string;
                else if(!strcmp(field, "section")) section = val.u.string;
                else if(!strcmp(field, "key"))     key     = val.u.string;
            }
            if(key.empty()) continue;   // the keyless script-binding entries
            if(owner == "console" || section == "input_console") consoleKeys++;
        }
    }
    mpv_free_node_contents(&bindings);

#ifdef DEBUG_LOG
    std::cout << "[MPV]: console-owned key bindings=" << consoleKeys << "\n";
#endif
    // A handful is enough to tell the open list from an empty one without
    // depending on how any single binding is spelled.
    return consoleKeys >= 5;
}

void HandleMpvPasteClipboard()
{
    std::vector<std::string> keys = Utf8ToKeyNames(GetClipboardUtf8());
    if(keys.empty()) return;

    // One thread for the whole paste rather than HandleMpvCommand per
    // character: the keys have to land in order, and a thread each does not
    // guarantee that. The lock is taken per key so a shutdown mid-paste still
    // wins instead of waiting out the whole string.
    std::thread([keys = std::move(keys)](){
        if(!IsMpvConsoleOpen()) return;
        for(size_t i=0; i<keys.size(); ++i){
            // The FIFO is raised well past a full paste, but the console
            // script still has to redraw per character; yielding now and then
            // lets it drain instead of racing it to the limit.
            if(i && i % 64 == 0) Sleep(1);
            std::shared_lock lock(g_mpvMutex);
            if(!g_mpv) return;
            const char* cargs[] = { "keypress", keys[i].c_str(), nullptr };
            mpv_command(g_mpv, cargs);
        }
    }).detach();
}

void pauseMPV(bool allowed)
{
    if(!allowed) return;
    std::vector<std::string> pauseArgs = { "pause", "true" };
    HandleMpvSetProp(pauseArgs);
}

bool InitMPV(HWND hwnd)
{
    g_mpv = mpv_create();
    if(!g_mpv){
        std::cerr<<"mpv_create failed\n";
        AppendToCrashLog("[MPV]: Create failed");
        return false;
    }

    // portable_config
    std::wstring exeDir = GetExeDirectory();
    std::wstring cfg    = exeDir + L"\\portable_config";
    CreateDirectoryW(cfg.c_str(), nullptr);

    // Convert config path to UTF-8
    int needed = WideCharToMultiByte(CP_UTF8, 0, cfg.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string utf8(needed, 0);
    WideCharToMultiByte(CP_UTF8, 0, cfg.c_str(), -1, &utf8[0], needed, nullptr, nullptr);

    mpv_set_option_string(g_mpv, "config-dir", utf8.c_str());
    mpv_set_option_string(g_mpv, "load-scripts","yes");
    mpv_set_option_string(g_mpv, "config","yes");
    mpv_set_option_string(g_mpv, "terminal","yes");
    // mpv drops key-derived commands once this many are queued ahead of the
    // playloop ("Buffer queue overflow, dropping."), and the default of 7 is
    // nowhere near a pasted line -- HandleMpvPasteClipboard sends one key per
    // character. Nothing else here queues in bulk, so the usual cost of a big
    // FIFO (reacting to input long after it happened) does not apply.
    mpv_set_option_string(g_mpv, "input-key-fifo-size","2048");
    mpv_set_option_string(g_mpv, "msg-level","all=v");

    int64_t wid=(int64_t)hwnd;
    mpv_set_option(g_mpv,"wid", MPV_FORMAT_INT64, &wid);
    mpv_set_wakeup_callback(g_mpv, MpvWakeup, hwnd);

    if(mpv_initialize(g_mpv)<0){
        std::cerr<<"mpv_initialize failed\n";
        AppendToCrashLog("[MPV]: Initialize failed");
        return false;
    }

    // Disabled for now -- not showing up as expected and not currently needed.
    //mpv_set_property_string(g_mpv,"log-file", (utf8 + "\\LOG.txt").c_str());

    // Set VO
    mpv_set_option_string(g_mpv,"vo","gpu-next");

    // demux/caching
    mpv_set_property_string(g_mpv,"demuxer-lavf-probesize",     "524288");
    mpv_set_property_string(g_mpv,"demuxer-lavf-analyzeduration","0.5");
    mpv_set_property_string(g_mpv,"demuxer-max-bytes","300000000");
    mpv_set_property_string(g_mpv,"demuxer-max-packets","150000000");
    mpv_set_property_string(g_mpv,"cache","yes");
    mpv_set_property_string(g_mpv,"cache-pause","no");
    mpv_set_property_string(g_mpv,"cache-secs","60");
    mpv_set_property_string(g_mpv,"vd-lavc-threads","0");
    mpv_set_property_string(g_mpv,"ad-lavc-threads","0");
    mpv_set_property_string(g_mpv,"audio-fallback-to-null","yes");
    mpv_set_property_string(g_mpv,"audio-client-name",APP_NAME);
    mpv_set_property_string(g_mpv,"title",APP_NAME);

    // Observe chapters
    mpv_observe_property(g_mpv, 0, "chapter", MPV_FORMAT_INT64);
    mpv_observe_property(g_mpv, 0, "chapter-list", MPV_FORMAT_NODE);
    mpv_observe_property(g_mpv, 0, "duration", MPV_FORMAT_DOUBLE);

    return true;
}

void CleanupMPV()
{
    std::unique_lock lock(g_mpvMutex);
    if(g_mpv){
        mpv_terminate_destroy(g_mpv);
        g_mpv=nullptr;
    }
}
