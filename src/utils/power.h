#ifndef POWER_H
#define POWER_H

#include <string>

// Ends the session: "quit" closes Stremio, "sleep" suspends the machine,
// "shutdown" powers it off. Anything else is ignored.
//
// Driven by the "power-action" event (see HandleEvent), which the power-menu
// webmod posts. Callers are responsible for the origin check - this is the one
// shell capability with no allow-list of its own to hide behind.
void RunPowerAction(const std::string& action);

// True when `uri` belongs to the web UI the shell itself loaded. Used to keep
// power actions out of reach of addon pages, which share the same WebView.
bool IsTrustedOrigin(const std::wstring& uri);

#endif // POWER_H
