#ifndef CONFIG_H
#define CONFIG_H

#include <string>

// Default ceiling the player is allowed to reach, overridable via [MPV]
// MaxVolume. Drives mpv's `volume-max` and the value the web UI's volume bar is
// seeded to (its own Max Volume dropdown offers up to 225).
constexpr int kDefaultMaxVolume = 200;
// A ceiling below 100 would leave no usable range; above this mpv clips anyway.
constexpr int kMaxVolumeFloor = 100;
constexpr int kMaxVolumeCeiling = 1000;

// InitialVolume only ever remembers unboosted levels. A session that ended at
// 180% should not start the next one deafening.
constexpr int kMaxInitialVolume = 100;

// Settings that change while the app runs. The .ini supplies the starting value
// and nothing else reads it afterwards -- this object is the source of truth,
// and the .ini is only ever written back from it. Everything else in the .ini is
// read once at startup and lives in its own global.
struct CachedSettings
{
    bool discordRpc    = true;  // [General] DiscordRPC
    int  initialVolume = 50;    // [MPV] InitialVolume, always 0..kMaxInitialVolume
    int  maxVolume     = kDefaultMaxVolume;  // [MPV] MaxVolume
};

extern CachedSettings g_settings;

void LoadSettings();
void SaveSettings();

// Runtime mutators for the cache. Both no-op when the value has not moved, so
// they are cheap to call from the mpv event loop and the web bridge.
void SetDiscordRpc(bool on);
void NoteVolume(int volume);
// Writes the cache out if NoteVolume() has moved it since the last save. Volume
// ticks every time the user nudges the slider, so it is flushed on exit rather
// than on every change.
void FlushSettings();

void SaveWindowPlacement(const WINDOWPLACEMENT &wp);
bool LoadWindowPlacement(WINDOWPLACEMENT &wp);
static void WriteIntToIni(const std::wstring &section, const std::wstring &key, int value, const std::wstring &iniPath);
#endif // CONFIG_H
