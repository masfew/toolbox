"""Win32, GDI, GDI+ and DWM declarations shared by the tray icon (tray.py) and its
flyout (flyout.py), through ctypes. Standard library only.

Every function used gets its argument and return types declared here, so 64-bit
handles aren't truncated. kernel32 is wispr_mute's, which declares the mutex and
event calls the tray also uses.
"""

import ctypes
from ctypes import wintypes

import wispr_mute

user32 = ctypes.WinDLL("user32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
gdiplus = ctypes.WinDLL("gdiplus")
dwmapi = ctypes.WinDLL("dwmapi")
comdlg32 = ctypes.WinDLL("comdlg32")
versiondll = ctypes.WinDLL("version")
kernel32 = wispr_mute.kernel32
try:
    shcore = ctypes.WinDLL("shcore")
except OSError:  # before Windows 8.1
    shcore = None

LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

# Window messages
WM_NULL, WM_DESTROY, WM_ACTIVATE, WM_PAINT, WM_CLOSE = 0x0000, 0x0002, 0x0006, 0x000F, 0x0010
WM_ERASEBKGND, WM_SETTINGCHANGE, WM_CONTEXTMENU, WM_DISPLAYCHANGE = 0x0014, 0x001A, 0x007B, 0x007E
WM_KEYDOWN, WM_TIMER, WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP = 0x0100, 0x0113, 0x0200, 0x0201, 0x0202
WM_MOUSELEAVE, WM_DPICHANGED, WM_APP = 0x02A3, 0x02E0, 0x8000
WA_INACTIVE = 0
# Notification-area icon
NIN_SELECT, NIN_KEYSELECT = 0x0400, 0x0401
NIM_ADD, NIM_MODIFY, NIM_DELETE, NIM_SETVERSION = 0, 1, 2, 4
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_SHOWTIP = 0x01, 0x02, 0x04, 0x80
NOTIFYICON_VERSION_4 = 4
# Menus
MF_STRING, MF_GRAYED, MF_SEPARATOR = 0x0, 0x1, 0x800
TPM_CENTERALIGN, TPM_TOPALIGN, TPM_BOTTOMALIGN = 0x4, 0x0, 0x20
TPM_RIGHTBUTTON, TPM_NONOTIFY, TPM_RETURNCMD = 0x2, 0x80, 0x100
# Windows, input, metrics
WS_POPUP = 0x80000000
WS_EX_TOPMOST, WS_EX_TOOLWINDOW = 0x8, 0x80
SW_HIDE, SW_SHOWNOACTIVATE, SW_SHOW = 0, 4, 5
WS_EX_NOACTIVATE = 0x08000000
WM_RBUTTONUP = 0x0205
MF_CHECKED = 0x8
OFN_FILEMUSTEXIST, OFN_PATHMUSTEXIST, OFN_NOCHANGEDIR = 0x1000, 0x800, 0x8
DIB_RGB_COLORS = 0
SWP_NOZORDER, SWP_NOACTIVATE = 0x4, 0x10
IDC_ARROW = 32512
TME_LEAVE = 0x2
VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_TAB, VK_RETURN, VK_SHIFT = 0x01, 0x02, 0x04, 0x09, 0x0D, 0x10
VK_ESCAPE, VK_SPACE, VK_LEFT, VK_UP, VK_RIGHT, VK_DOWN = 0x1B, 0x20, 0x25, 0x26, 0x27, 0x28
VK_DELETE, VK_APPS = 0x2E, 0x5D
TPM_LEFTALIGN = 0x0
DASH_STYLE_DASH = 1
SM_CXSMICON = 49
MONITOR_DEFAULTTONEAREST = 2
MDT_EFFECTIVE_DPI = 0
WAIT_OBJECT_0 = 0
DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)
# GDI
SRCCOPY = 0x00CC0020
TRANSPARENT = 1
DEFAULT_CHARSET, CLEARTYPE_QUALITY = 1, 5
DT_LEFT, DT_CENTER, DT_VCENTER, DT_SINGLELINE, DT_NOPREFIX = 0x0, 0x1, 0x4, 0x20, 0x800
# DWM (Windows 11 attributes are ignored on older Windows)
DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE = 20, 33
DWMWCP_ROUND = 2
# GDI+
SMOOTHING_ANTIALIAS, PIXEL_OFFSET_HALF, UNIT_PIXEL = 4, 4, 2
PIXEL_FORMAT_32BPP_ARGB = 0x26200A
INTERPOLATION_DEFAULT, INTERPOLATION_HIGH_QUALITY_BICUBIC = 0, 7


class WNDCLASSW(ctypes.Structure):
    _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
                ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]


class NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND), ("uID", wintypes.UINT),
                ("uFlags", wintypes.UINT), ("uCallbackMessage", wintypes.UINT), ("hIcon", wintypes.HICON),
                ("szTip", ctypes.c_wchar * 128), ("dwState", wintypes.DWORD), ("dwStateMask", wintypes.DWORD),
                ("szInfo", ctypes.c_wchar * 256), ("uVersion", wintypes.UINT),
                ("szInfoTitle", ctypes.c_wchar * 64), ("dwInfoFlags", wintypes.DWORD),
                ("guidItem", ctypes.c_byte * 16), ("hBalloonIcon", wintypes.HICON)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


class ICONINFO(ctypes.Structure):
    _fields_ = [("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD), ("yHotspot", wintypes.DWORD),
                ("hbmMask", wintypes.HBITMAP), ("hbmColor", wintypes.HBITMAP)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD)]


class MSG(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("message", wintypes.UINT), ("wParam", wintypes.WPARAM),
                ("lParam", wintypes.LPARAM), ("time", wintypes.DWORD), ("pt", wintypes.POINT),
                ("lPrivate", wintypes.DWORD)]


class PAINTSTRUCT(ctypes.Structure):
    _fields_ = [("hdc", wintypes.HDC), ("fErase", wintypes.BOOL), ("rcPaint", wintypes.RECT),
                ("fRestore", wintypes.BOOL), ("fIncUpdate", wintypes.BOOL), ("rgbReserved", ctypes.c_byte * 32)]


class TRACKMOUSEEVENT(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("dwFlags", wintypes.DWORD), ("hwndTrack", wintypes.HWND),
                ("dwHoverTime", wintypes.DWORD)]


class BITMAP(ctypes.Structure):
    _fields_ = [("bmType", wintypes.LONG), ("bmWidth", wintypes.LONG), ("bmHeight", wintypes.LONG),
                ("bmWidthBytes", wintypes.LONG), ("bmPlanes", wintypes.WORD), ("bmBitsPixel", wintypes.WORD),
                ("bmBits", ctypes.c_void_p)]


class BITMAPINFO256(ctypes.Structure):
    """BITMAPINFO with room for a full colour table, so GetDIBits can never overrun it."""
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 256)]


class OPENFILENAMEW(ctypes.Structure):
    _fields_ = [("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND), ("hInstance", wintypes.HINSTANCE),
                ("lpstrFilter", wintypes.LPCWSTR), ("lpstrCustomFilter", wintypes.LPWSTR),
                ("nMaxCustFilter", wintypes.DWORD), ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR),
                ("nMaxFile", wintypes.DWORD), ("lpstrFileTitle", wintypes.LPWSTR), ("nMaxFileTitle", wintypes.DWORD),
                ("lpstrInitialDir", wintypes.LPCWSTR), ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD),
                ("nFileOffset", wintypes.WORD), ("nFileExtension", wintypes.WORD), ("lpstrDefExt", wintypes.LPCWSTR),
                ("lCustData", wintypes.LPARAM), ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wintypes.LPCWSTR),
                ("pvReserved", ctypes.c_void_p), ("dwReserved", wintypes.DWORD), ("FlagsEx", wintypes.DWORD)]


class GdiplusStartupInput(ctypes.Structure):
    _fields_ = [("GdiplusVersion", ctypes.c_uint32), ("DebugEventCallback", ctypes.c_void_p),
                ("SuppressBackgroundThread", wintypes.BOOL), ("SuppressExternalCodecs", wintypes.BOOL)]


def _sig(fn, restype, *argtypes):
    fn.restype, fn.argtypes = restype, argtypes


P, PVOID, HANDLE = ctypes.POINTER, ctypes.c_void_p, wintypes.HANDLE
INT, UINT, REAL = ctypes.c_int, wintypes.UINT, ctypes.c_float

# user32: windows, messages, painting, input
_sig(user32.RegisterClassW, wintypes.ATOM, P(WNDCLASSW))
_sig(user32.CreateWindowExW, wintypes.HWND, wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
     INT, INT, INT, INT, wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID)
_sig(user32.DefWindowProcW, LRESULT, wintypes.HWND, UINT, wintypes.WPARAM, wintypes.LPARAM)
_sig(user32.DestroyWindow, wintypes.BOOL, wintypes.HWND)
_sig(user32.ShowWindow, wintypes.BOOL, wintypes.HWND, INT)
_sig(user32.SetWindowPos, wintypes.BOOL, wintypes.HWND, wintypes.HWND, INT, INT, INT, INT, UINT)
_sig(user32.PostQuitMessage, None, INT)
_sig(user32.GetMessageW, wintypes.BOOL, P(MSG), wintypes.HWND, UINT, UINT)
_sig(user32.TranslateMessage, wintypes.BOOL, P(MSG))
_sig(user32.DispatchMessageW, LRESULT, P(MSG))
_sig(user32.RegisterWindowMessageW, UINT, wintypes.LPCWSTR)
_sig(user32.SetTimer, ctypes.c_size_t, wintypes.HWND, ctypes.c_size_t, UINT, wintypes.LPVOID)
_sig(user32.KillTimer, wintypes.BOOL, wintypes.HWND, ctypes.c_size_t)
_sig(user32.SetForegroundWindow, wintypes.BOOL, wintypes.HWND)
_sig(user32.PostMessageW, wintypes.BOOL, wintypes.HWND, UINT, wintypes.WPARAM, wintypes.LPARAM)
_sig(user32.GetSystemMetrics, INT, INT)
_sig(user32.GetDC, wintypes.HDC, wintypes.HWND)
_sig(user32.ReleaseDC, INT, wintypes.HWND, wintypes.HDC)
_sig(user32.BeginPaint, wintypes.HDC, wintypes.HWND, P(PAINTSTRUCT))
_sig(user32.EndPaint, wintypes.BOOL, wintypes.HWND, P(PAINTSTRUCT))
_sig(user32.InvalidateRect, wintypes.BOOL, wintypes.HWND, P(wintypes.RECT), wintypes.BOOL)
_sig(user32.DrawTextW, INT, wintypes.HDC, wintypes.LPCWSTR, INT, P(wintypes.RECT), UINT)
_sig(user32.TrackMouseEvent, wintypes.BOOL, P(TRACKMOUSEEVENT))
_sig(user32.LoadCursorW, wintypes.HANDLE, wintypes.HINSTANCE, PVOID)
_sig(user32.GetCursorPos, wintypes.BOOL, P(wintypes.POINT))
_sig(user32.GetWindowRect, wintypes.BOOL, wintypes.HWND, P(wintypes.RECT))
_sig(user32.GetAsyncKeyState, ctypes.c_short, INT)
_sig(user32.GetKeyState, ctypes.c_short, INT)
_sig(user32.CreateIconIndirect, wintypes.HICON, P(ICONINFO))
_sig(user32.DestroyIcon, wintypes.BOOL, wintypes.HICON)
_sig(user32.MessageBoxW, INT, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, UINT)
_sig(user32.MonitorFromPoint, wintypes.HMONITOR, wintypes.POINT, wintypes.DWORD)
_sig(user32.GetMonitorInfoW, wintypes.BOOL, wintypes.HMONITOR, P(MONITORINFO))
# user32: menus
_sig(user32.CreatePopupMenu, wintypes.HMENU)
_sig(user32.AppendMenuW, wintypes.BOOL, wintypes.HMENU, UINT, ctypes.c_size_t, wintypes.LPCWSTR)
_sig(user32.TrackPopupMenuEx, wintypes.BOOL, wintypes.HMENU, UINT, INT, INT, wintypes.HWND, wintypes.LPVOID)
_sig(user32.DestroyMenu, wintypes.BOOL, wintypes.HMENU)
try:  # Windows 10 1607 and later
    _sig(user32.GetDpiForSystem, UINT)
    _sig(user32.GetSystemMetricsForDpi, INT, INT, UINT)
    _sig(user32.SetProcessDpiAwarenessContext, wintypes.BOOL, PVOID)
except AttributeError:
    pass
if shcore is not None:
    _sig(shcore.GetDpiForMonitor, ctypes.HRESULT, wintypes.HMONITOR, INT, P(UINT), P(UINT))

_sig(user32.GetIconInfo, wintypes.BOOL, wintypes.HICON, P(ICONINFO))
_sig(user32.ClientToScreen, wintypes.BOOL, wintypes.HWND, P(wintypes.POINT))

# shell32, kernel32, comdlg32, version
_sig(shell32.Shell_NotifyIconW, wintypes.BOOL, wintypes.DWORD, P(NOTIFYICONDATAW))
_sig(shell32.SHDefExtractIconW, ctypes.HRESULT, wintypes.LPCWSTR, INT, UINT, P(wintypes.HICON), P(wintypes.HICON),
     UINT)
_sig(comdlg32.GetOpenFileNameW, wintypes.BOOL, P(OPENFILENAMEW))
_sig(versiondll.GetFileVersionInfoSizeW, wintypes.DWORD, wintypes.LPCWSTR, P(wintypes.DWORD))
_sig(versiondll.GetFileVersionInfoW, wintypes.BOOL, wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, PVOID)
_sig(versiondll.VerQueryValueW, wintypes.BOOL, PVOID, wintypes.LPCWSTR, P(PVOID), P(UINT))
_sig(kernel32.GetModuleHandleW, wintypes.HMODULE, wintypes.LPCWSTR)
_sig(kernel32.WaitForSingleObject, wintypes.DWORD, HANDLE, wintypes.DWORD)

# gdi32
_sig(gdi32.CreateFontW, wintypes.HFONT, INT, INT, INT, INT, INT, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
     wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.LPCWSTR)
_sig(gdi32.SelectObject, wintypes.HGDIOBJ, wintypes.HDC, wintypes.HGDIOBJ)
_sig(gdi32.DeleteObject, wintypes.BOOL, wintypes.HGDIOBJ)
_sig(gdi32.GetTextExtentPoint32W, wintypes.BOOL, wintypes.HDC, wintypes.LPCWSTR, INT, P(wintypes.SIZE))
_sig(gdi32.CreateDIBSection, wintypes.HBITMAP, wintypes.HDC, P(BITMAPINFOHEADER), UINT, P(PVOID), HANDLE,
     wintypes.DWORD)
_sig(gdi32.CreateBitmap, wintypes.HBITMAP, INT, INT, UINT, UINT, PVOID)
_sig(gdi32.CreateCompatibleDC, wintypes.HDC, wintypes.HDC)
_sig(gdi32.DeleteDC, wintypes.BOOL, wintypes.HDC)
_sig(gdi32.BitBlt, wintypes.BOOL, wintypes.HDC, INT, INT, INT, INT, wintypes.HDC, INT, INT, wintypes.DWORD)
_sig(gdi32.SetTextColor, wintypes.COLORREF, wintypes.HDC, wintypes.COLORREF)
_sig(gdi32.SetBkMode, INT, wintypes.HDC, INT)
_sig(gdi32.GetObjectW, INT, wintypes.HGDIOBJ, INT, PVOID)
_sig(gdi32.GetDIBits, INT, wintypes.HDC, wintypes.HBITMAP, UINT, UINT, PVOID, P(BITMAPINFO256), UINT)

# dwmapi
_sig(dwmapi.DwmSetWindowAttribute, ctypes.HRESULT, wintypes.HWND, wintypes.DWORD, PVOID, wintypes.DWORD)

# gdiplus (flat API; every call returns a status, 0 = Ok)
_sig(gdiplus.GdiplusStartup, INT, P(ctypes.c_size_t), P(GdiplusStartupInput), PVOID)
_sig(gdiplus.GdipCreateFromHDC, INT, wintypes.HDC, P(PVOID))
_sig(gdiplus.GdipDeleteGraphics, INT, PVOID)
_sig(gdiplus.GdipSetSmoothingMode, INT, PVOID, INT)
_sig(gdiplus.GdipSetPixelOffsetMode, INT, PVOID, INT)
_sig(gdiplus.GdipSetInterpolationMode, INT, PVOID, INT)
_sig(gdiplus.GdipCreateSolidFill, INT, ctypes.c_uint32, P(PVOID))
_sig(gdiplus.GdipDeleteBrush, INT, PVOID)
_sig(gdiplus.GdipCreatePen1, INT, ctypes.c_uint32, REAL, INT, P(PVOID))
_sig(gdiplus.GdipDeletePen, INT, PVOID)
_sig(gdiplus.GdipSetPenDashStyle, INT, PVOID, INT)
_sig(gdiplus.GdipCreatePath, INT, INT, P(PVOID))
_sig(gdiplus.GdipDeletePath, INT, PVOID)
_sig(gdiplus.GdipAddPathArc, INT, PVOID, REAL, REAL, REAL, REAL, REAL, REAL)
_sig(gdiplus.GdipClosePathFigure, INT, PVOID)
_sig(gdiplus.GdipFillPath, INT, PVOID, PVOID, PVOID)
_sig(gdiplus.GdipDrawPath, INT, PVOID, PVOID, PVOID)
_sig(gdiplus.GdipFillRectangleI, INT, PVOID, PVOID, INT, INT, INT, INT)
_sig(gdiplus.GdipCreateBitmapFromScan0, INT, INT, INT, INT, INT, PVOID, P(PVOID))
_sig(gdiplus.GdipDrawImageRectI, INT, PVOID, PVOID, INT, INT, INT, INT)
_sig(gdiplus.GdipDisposeImage, INT, PVOID)
