"""Minimal Windows Core Audio access through ctypes: output devices, their mute
switch, the per-app volume sessions on them, and which apps are recording from a
microphone. Standard library only.

Every COM call goes through a vtable index; the interface layouts are from the
Windows SDK headers (mmdeviceapi.h, endpointvolume.h, audiopolicy.h).
"""

import ctypes
import time
import uuid
from ctypes import wintypes

ole32 = ctypes.WinDLL("ole32")


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8)]

    def __init__(self, text):
        super().__init__()
        ctypes.memmove(ctypes.byref(self), uuid.UUID(text).bytes_le, 16)


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", wintypes.DWORD)]


class PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", wintypes.WORD), ("r1", wintypes.WORD), ("r2", wintypes.WORD),
                ("r3", wintypes.WORD), ("pwszVal", ctypes.c_void_p), ("pad", ctypes.c_void_p)]


ole32.CoInitializeEx.argtypes = (ctypes.c_void_p, wintypes.DWORD)
ole32.CoInitializeEx.restype = ctypes.HRESULT
ole32.CoCreateInstance.argtypes = (ctypes.POINTER(GUID), ctypes.c_void_p, wintypes.DWORD,
                                   ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))
ole32.CoCreateInstance.restype = ctypes.HRESULT
ole32.CoTaskMemFree.argtypes = (ctypes.c_void_p,)
ole32.PropVariantClear.argtypes = (ctypes.POINTER(PROPVARIANT),)

CLSID_MMDeviceEnumerator = GUID("BCDE0395-E52F-467C-8E3D-C4579291692E")
IID_IMMDeviceEnumerator = GUID("A95664D2-9614-4F35-A746-DE8DB63617E6")
IID_IAudioEndpointVolume = GUID("5CDF2C82-841E-4546-9722-0CF74078229A")
IID_IAudioSessionManager2 = GUID("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")
IID_IAudioSessionControl2 = GUID("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")
IID_ISimpleAudioVolume = GUID("87CE5498-68D6-44E5-9215-6DA47EF883D8")
PKEY_Device_FriendlyName = PROPERTYKEY(GUID("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14)

CLSCTX_ALL = 23
E_RENDER = 0
E_CAPTURE = 1
E_CONSOLE = 0
AUDIO_SESSION_STATE_ACTIVE = 1
DEVICE_STATE_ACTIVE = 1
STGM_READ = 0
VT_LPWSTR = 31

P = ctypes.POINTER
PVOID = ctypes.c_void_p


def init_com():
    """Initialise COM on this thread (multithreaded). Safe to call more than once."""
    try:
        ole32.CoInitializeEx(None, 0)
    except OSError:
        pass  # already initialised in another mode; calls still work


class Com:
    """A COM interface pointer; released when collected."""

    def __init__(self, ptr):
        self.ptr = ptr

    def call(self, index, argtypes, *args):
        vtbl = ctypes.cast(self.ptr, P(P(PVOID))).contents
        return ctypes.WINFUNCTYPE(ctypes.HRESULT, PVOID, *argtypes)(vtbl[index])(self.ptr, *args)

    def out(self, index, argtypes=(), *args):
        """Call a method whose last parameter is an interface out-pointer."""
        result = PVOID()
        self.call(index, (*argtypes, P(PVOID)), *args, ctypes.byref(result))
        return Com(result)

    def query(self, iid):
        return self.out(0, (P(GUID),), ctypes.byref(iid))

    def __del__(self):
        if self.ptr and self.ptr.value:
            vtbl = ctypes.cast(self.ptr, P(P(PVOID))).contents
            ctypes.WINFUNCTYPE(wintypes.ULONG, PVOID)(vtbl[2])(self.ptr)
            self.ptr = None


def _enumerator():
    out = PVOID()
    ole32.CoCreateInstance(ctypes.byref(CLSID_MMDeviceEnumerator), None, CLSCTX_ALL,
                           ctypes.byref(IID_IMMDeviceEnumerator), ctypes.byref(out))
    return Com(out)


def _activate(device, iid):
    return device.out(3, (P(GUID), wintypes.DWORD, PVOID), ctypes.byref(iid), CLSCTX_ALL, None)


class Session:
    """One app's volume session on an output device (the per-app slider in the mixer)."""

    def __init__(self, pid, instance_id, volume):
        self.pid = pid
        self.instance_id = instance_id  # unique to this session; a restarted app gets a new one
        self._volume = volume  # ISimpleAudioVolume

    @property
    def level(self):
        value = ctypes.c_float()
        self._volume.call(4, (P(ctypes.c_float),), ctypes.byref(value))
        return value.value

    @level.setter
    def level(self, value):
        self._volume.call(3, (ctypes.c_float, PVOID), value, None)

    @property
    def muted(self):
        value = wintypes.BOOL()
        self._volume.call(6, (P(wintypes.BOOL),), ctypes.byref(value))
        return bool(value.value)

    @muted.setter
    def muted(self, value):
        self._volume.call(5, (wintypes.BOOL, PVOID), bool(value), None)


class OutputDevice:
    def __init__(self, device):
        self._device = device  # IMMDevice
        raw = PVOID()
        device.call(5, (P(PVOID),), ctypes.byref(raw))
        self.id = ctypes.wstring_at(raw.value)
        ole32.CoTaskMemFree(raw)
        self._endpoint = _activate(device, IID_IAudioEndpointVolume)
        self._manager = None  # IAudioSessionManager2, activated on first sessions() call

    @classmethod
    def default(cls):
        return cls(_enumerator().out(4, (ctypes.c_int, ctypes.c_int), E_RENDER, E_CONSOLE))

    @classmethod
    def by_id(cls, device_id):
        return cls(_enumerator().out(5, (ctypes.c_wchar_p,), device_id))

    @classmethod
    def all_active(cls):
        collection = _enumerator().out(3, (ctypes.c_int, wintypes.DWORD), E_RENDER, DEVICE_STATE_ACTIVE)
        count = wintypes.UINT()
        collection.call(3, (P(wintypes.UINT),), ctypes.byref(count))
        return [cls(collection.out(4, (wintypes.UINT,), i)) for i in range(count.value)]

    @property
    def name(self):
        try:
            store = self._device.out(4, (wintypes.DWORD,), STGM_READ)
            value = PROPVARIANT()
            store.call(5, (P(PROPERTYKEY), P(PROPVARIANT)), ctypes.byref(PKEY_Device_FriendlyName),
                       ctypes.byref(value))
            text = ctypes.wstring_at(value.pwszVal) if value.vt == VT_LPWSTR and value.pwszVal else ""
            ole32.PropVariantClear(ctypes.byref(value))
            return text or self.id
        except OSError:
            return self.id

    @property
    def muted(self):
        value = wintypes.BOOL()
        self._endpoint.call(15, (P(wintypes.BOOL),), ctypes.byref(value))
        return bool(value.value)

    @muted.setter
    def muted(self, value):
        self._endpoint.call(14, (wintypes.BOOL, PVOID), bool(value), None)

    def sessions(self):
        if self._manager is None:
            self._manager = _activate(self._device, IID_IAudioSessionManager2)
        sessions = self._manager.out(5)
        count = ctypes.c_int()
        sessions.call(3, (P(ctypes.c_int),), ctypes.byref(count))
        result = []
        for i in range(count.value):
            control = sessions.out(4, (ctypes.c_int,), i)
            control2 = control.query(IID_IAudioSessionControl2)
            pid = wintypes.DWORD()
            control2.call(14, (P(wintypes.DWORD),), ctypes.byref(pid))
            raw = PVOID()
            control2.call(13, (P(PVOID),), ctypes.byref(raw))
            instance_id = ctypes.wstring_at(raw.value) if raw.value else ""
            ole32.CoTaskMemFree(raw)
            result.append(Session(pid.value, instance_id, control.query(IID_ISimpleAudioVolume)))
        return result


class CaptureSessions:
    """Which processes are recording from a microphone right now: the pids of active
    sessions on every active capture device (about 0.5 ms a check). The device list is
    refreshed every `refresh_s`, so a mic plugged in later is picked up."""

    def __init__(self, refresh_s=5.0):
        self.refresh_s = refresh_s
        self._managers = []  # IAudioSessionManager2 per capture device
        self._fetched = None

    def _refresh(self):
        collection = _enumerator().out(3, (ctypes.c_int, wintypes.DWORD), E_CAPTURE, DEVICE_STATE_ACTIVE)
        count = wintypes.UINT()
        collection.call(3, (P(wintypes.UINT),), ctypes.byref(count))
        self._managers = [_activate(collection.out(4, (wintypes.UINT,), i), IID_IAudioSessionManager2)
                          for i in range(count.value)]
        self._fetched = time.monotonic()

    def active_pids(self):
        if self._fetched is None or time.monotonic() - self._fetched > self.refresh_s:
            self._refresh()
        pids = set()
        try:
            for manager in self._managers:
                sessions = manager.out(5)
                count = ctypes.c_int()
                sessions.call(3, (P(ctypes.c_int),), ctypes.byref(count))
                for i in range(count.value):
                    control = sessions.out(4, (ctypes.c_int,), i)
                    state = ctypes.c_int()
                    control.call(3, (P(ctypes.c_int),), ctypes.byref(state))
                    if state.value == AUDIO_SESSION_STATE_ACTIVE:
                        pid = wintypes.DWORD()
                        control.query(IID_IAudioSessionControl2).call(14, (P(wintypes.DWORD),), ctypes.byref(pid))
                        pids.add(pid.value)
        except OSError:
            self._fetched = None  # a device went away; re-enumerate on the next check
            raise
        return pids
