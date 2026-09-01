#include "power.h"

#include <windows.h>
#include <powrprof.h>
#include <iostream>

#include "../core/globals.h"
#include "../utils/config.h"
#include "../utils/crashlog.h"
#include "../utils/helpers.h"

// Shutting the machine down needs a privilege the process holds but does not
// have enabled by default. Enabling it is per-call rather than at startup so the
// token only carries it for the moment it is used.
static bool EnableShutdownPrivilege()
{
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(),
                          TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token)) {
        return false;
    }

    TOKEN_PRIVILEGES tp = {};
    tp.PrivilegeCount = 1;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    // Spelled out rather than SE_SHUTDOWN_NAME: the project does not define
    // UNICODE, so that macro expands to the narrow string and will not pass to
    // the W entry point the rest of the shell calls.
    bool ok = LookupPrivilegeValueW(nullptr, L"SeShutdownPrivilege",
                                    &tp.Privileges[0].Luid) != 0;
    if (ok) {
        AdjustTokenPrivileges(token, FALSE, &tp, 0, nullptr, nullptr);
        // AdjustTokenPrivileges reports success even when it enabled nothing.
        ok = (GetLastError() == ERROR_SUCCESS);
    }
    CloseHandle(token);
    return ok;
}

bool IsTrustedOrigin(const std::wstring& uri)
{
    if (uri.empty()) return false;
    if (!g_webuiUrl.empty() && uri.rfind(g_webuiUrl, 0) == 0) return true;
    // g_webuiUrl is whichever of the candidates turned out to be reachable; the
    // others are still the shell's own UI and may be navigated to on a refresh.
    for (const auto& candidate : g_webuiUrls) {
        if (uri.rfind(candidate, 0) == 0) return true;
    }
    return false;
}

void RunPowerAction(const std::string& action)
{
    AppendToCrashLog("[POWER]: action => " + action);

    if (action == "quit") {
        // The tray's Quit item already does the whole dance - tell mpv to quit,
        // save the window placement, destroy the window - so drive that rather
        // than growing a second copy of it here.
        PostMessage(g_hWnd, WM_COMMAND, ID_TRAY_QUIT, 0);
        return;
    }

    if (action == "sleep") {
        // Volume changes are only written on the way out (see NoteVolume), and
        // suspending is not an exit - flush before the machine goes away.
        FlushSettings();
        // bHibernate FALSE = sleep, bForce FALSE = let other apps object.
        if (!SetSuspendState(FALSE, FALSE, FALSE)) {
            AppendToCrashLog("[POWER]: SetSuspendState failed, err=" +
                             std::to_string(GetLastError()));
        }
        return;
    }

    if (action == "shutdown") {
        FlushSettings();
        if (!EnableShutdownPrivilege()) {
            AppendToCrashLog("[POWER]: SE_SHUTDOWN_NAME could not be enabled");
            return;
        }
        // FORCEIFHUNG rather than FORCE: an app that is merely slow to save still
        // gets its chance, only one that has stopped answering is killed.
        if (!ExitWindowsEx(EWX_SHUTDOWN | EWX_FORCEIFHUNG,
                           SHTDN_REASON_MAJOR_APPLICATION |
                           SHTDN_REASON_MINOR_MAINTENANCE |
                           SHTDN_REASON_FLAG_PLANNED)) {
            AppendToCrashLog("[POWER]: ExitWindowsEx failed, err=" +
                             std::to_string(GetLastError()));
        }
        return;
    }

    std::cout << "[POWER]: unknown action=" << action << "\n";
}
