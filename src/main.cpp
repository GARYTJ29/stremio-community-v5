#pragma comment(linker, "/SUBSYSTEM:WINDOWS")
#pragma comment(linker, "/ENTRY:mainCRTStartup")

#include "discord_rpc.h"
#include <windows.h>
#include <VersionHelpers.h>
#include <cstdint>
#include <gdiplus.h>
#include <iostream>
#include <shellscalingapi.h>
#include <sstream>

#include "core/globals.h"
#include "mpv/player.h"
#include "node/server.h"
#include "tray/tray.h"
#include "ui/mainwindow.h"
#include "ui/splash.h"
#include "updater/updater.h"
#include "utils/config.h"
#include "utils/crashlog.h"
#include "utils/discord.h"
#include "utils/helpers.h"
#include "webview/webview.h"
// This started as 1-week project so please don't take the code to seriously
int main(int argc, char *argv[]) {
  // Catch unhandled exceptions
  SetUnhandledExceptionFilter([](EXCEPTION_POINTERS *info) -> LONG {
    const EXCEPTION_RECORD *rec = info->ExceptionRecord;

    // Record where it faulted before touching anything else. The owning module is
    // what makes a bare 0xc0000005 attributable (libmpv vs WebView2 vs us).
    std::wstringstream ws;
    ws << L"Unhandled exception! Code=0x" << std::hex << rec->ExceptionCode
       << L" at 0x" << (uintptr_t)rec->ExceptionAddress;
    HMODULE mod = nullptr;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCWSTR)rec->ExceptionAddress, &mod) &&
        mod) {
      wchar_t modPath[MAX_PATH] = {};
      if (GetModuleFileNameW(mod, modPath, MAX_PATH)) {
        const wchar_t *name = wcsrchr(modPath, L'\\');
        ws << L" in " << (name ? name + 1 : modPath);
      }
    }
    if (rec->ExceptionCode == EXCEPTION_ACCESS_VIOLATION &&
        rec->NumberParameters >= 2) {
      ws << (rec->ExceptionInformation[0] ? L" writing 0x" : L" reading 0x")
         << std::hex << rec->ExceptionInformation[1];
    }
    AppendToCrashLog(ws.str());

    // Cleanup() takes g_mpvMutex and then blocks in mpv_terminate_destroy(). This
    // filter runs on the faulting thread, so if that thread already holds the mutex
    // -- which is exactly where an mpv-side fault lands -- calling it directly
    // self-deadlocks and the app hangs forever instead of dying. Give it its own
    // thread and a deadline, then go down whether or not it finished.
    HANDLE cleanupThread = CreateThread(
        nullptr, 0,
        [](LPVOID) -> DWORD {
          Cleanup();
          return 0;
        },
        nullptr, 0, nullptr);
    if (cleanupThread) {
      WaitForSingleObject(cleanupThread, 3000);
      CloseHandle(cleanupThread);
    }

    // Never return to the faulting instruction, and never let a wedged cleanup keep
    // the process -- and its window -- alive.
    TerminateProcess(GetCurrentProcess(), rec->ExceptionCode);
    return EXCEPTION_EXECUTE_HANDLER;
  });
  atexit(Cleanup);

  // DPI
  if (IsWindowsVersionOrGreater(10, 0, 14393)) {
    typedef BOOL(WINAPI * SetDpiCtxFn)(DPI_AWARENESS_CONTEXT);
    auto setDpiAwarenessContext = (SetDpiCtxFn)GetProcAddress(
        GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
    if (setDpiAwarenessContext) {
      setDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
  } else {
    // Fallback for Windows 8.1 and Windows 10 before 1607:
    SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
  }

  // parse cmd line
  for (int i = 1; i < argc; i++) {
    std::string arg(argv[i]);
    if (arg.rfind("--webui-url=", 0) == 0) {
      g_webuiUrls.insert(g_webuiUrls.begin(), Utf8ToWstring(arg.substr(12)));
    } else if (arg.rfind("--autoupdater-endpoint=", 0) == 0) {
      g_updateUrl = arg.substr(23);
    } else if (arg == "--streaming-server-disabled") {
      g_streamingServer = false;
    } else if (arg == "--autoupdater-force-full") {
      g_autoupdaterForceFull = true;
    }
  }

  // single instance
  std::wstring launchProtocol;
  if (!CheckSingleInstance(argc, argv, launchProtocol)) {
    return 0;
  }
  g_launchProtocol = launchProtocol;

  // check stremio-runtime duplicates
  std::vector<std::wstring> processesToCheck = {L"stremio.exe",
                                                L"stremio-runtime.exe"};
  if (IsDuplicateProcessRunning(processesToCheck)) {
    MessageBoxW(nullptr,
                L"An older version of Stremio or Stremio server may be "
                L"running. There could be issues.",
                L"Stremio Already Running", MB_OK | MB_ICONWARNING);
  }

  // init GDI+
  Gdiplus::GdiplusStartupInput gpsi;
  if (Gdiplus::GdiplusStartup(&g_gdiplusToken, &gpsi, nullptr) != Gdiplus::Ok) {
    AppendToCrashLog(L"[BOOT]: GdiplusStartup failed.");
    return 1;
  }

  // Load config
  LoadSettings();

  // Initialize Discord RPC
  InitializeDiscord();

  // Updater
  g_updaterThread = std::thread(RunAutoUpdaterOnce);
  g_updaterThread.detach();

  g_hInst = GetModuleHandle(nullptr);
  g_darkBrush = CreateSolidBrush(RGB(0, 0, 0));

  // Register main window class
  WNDCLASSEX wcex = {0};
  wcex.cbSize = sizeof(WNDCLASSEX);
  wcex.style = CS_HREDRAW | CS_VREDRAW;
  wcex.lpfnWndProc = WndProc;
  wcex.hInstance = g_hInst;
  wcex.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wcex.hbrBackground = g_darkBrush;
  wcex.lpszClassName = szWindowClass;
  if (!RegisterClassEx(&wcex)) {
    AppendToCrashLog(L"[BOOT]: RegisterClassEx failed!");
    return 1;
  }

  g_hWnd = CreateWindow(szWindowClass, szTitle, WS_OVERLAPPEDWINDOW,
                        CW_USEDEFAULT, CW_USEDEFAULT, 1200, 900, nullptr,
                        nullptr, g_hInst, nullptr);
  if (!g_hWnd) {
    AppendToCrashLog(L"[BOOT]: CreateWindow failed!");
    return 1;
  }

  // Add PlayPause Hotkey
  if (!RegisterHotKey(g_hWnd, 1, 0, VK_MEDIA_PLAY_PAUSE)) {
    AppendToCrashLog(L"[BOOT]: Failed to register hotkey!");
  }

  // Scale Values with DPI
  ScaleWithDPI();
  LoadCustomMenuFont();

  // Load Saved position
  WINDOWPLACEMENT wp;
  bool restoredMinimized = false;
  if (LoadWindowPlacement(wp)) {
    SetWindowPlacement(g_hWnd, &wp);
    ShowWindow(g_hWnd, wp.showCmd);
    UpdateWindow(g_hWnd);
    restoredMinimized = (wp.showCmd == SW_SHOWMINIMIZED || wp.showCmd == SW_MINIMIZE);
  } else {
    ShowWindow(g_hWnd, SW_SHOW);
    UpdateWindow(g_hWnd);
  }

  // When launched by another process (Xbox Game Bar / One Game Launcher, a
  // shortcut host, the updater relaunch) Windows withholds foreground rights,
  // so the window would otherwise come up behind or unfocused - and a
  // controller cannot make it fullscreen from there. Skip it only if the user
  // last left the shell minimized.
  if (!restoredMinimized) {
    ForceForegroundWindow(g_hWnd);
  }

  // create splash
  CreateSplashScreen(g_hWnd);

  // init mpv
  if (!InitMPV(g_hWnd)) {
    DestroyWindow(g_hWnd);
    return 1;
  }

  // node
  if (g_streamingServer) {
    StartNodeServer();
  }

  // webview
  InitWebView2(g_hWnd);

  // message loop
  MSG msg;
  while (GetMessage(&msg, nullptr, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessage(&msg);

    // Run Discord RPC callbacks
    Discord_RunCallbacks();
  }

  if (g_darkBrush) {
    DeleteObject(g_darkBrush);
    g_darkBrush = nullptr;
  }
  std::cout << "Exiting...\n";
  return (int)msg.wParam;
}
