#ifndef GAMEPAD_H
#define GAMEPAD_H

#include <string>

// Builds the controller-support module that gets injected into every document,
// with the current [Controller] .ini settings baked in as its config object.
std::wstring BuildGamepadScript();

// Pushes g_gamepadEnabled to the already-loaded page (tray toggle).
void ApplyGamepadEnabled();

#endif // GAMEPAD_H
