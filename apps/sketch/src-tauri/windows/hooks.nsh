; Explorer integration, added to Tauri's NSIS installer (bundle.windows.nsis.installerHooks).
; Pictures get "Open with" and "Edit with Sketch" without Sketch taking over what opens them by default,
; and Sketch is listed in Settings > Default apps, so people can choose it there. .sktch files are
; Sketch's own; tauri.conf.json's fileAssociations makes Sketch open them.

!macro SKETCH_PICTURE_TYPE EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "Sketch.Picture" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHCTX "Software\Sketch\Capabilities\FileAssociations" ".${EXT}" "Sketch.Picture"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Sketch.Edit" "MUIVerb" "Edit with Sketch"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Sketch.Edit" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Sketch.Edit\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro SKETCH_REMOVE_PICTURE_TYPE EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "Sketch.Picture"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Sketch.Edit"
!macroend

; A shortcut aimed at another copy of sketch.exe is pointed back at this install's (the launcher). An update doesn't make
; shortcuts again, so without this a Start menu shortcut left aimed at an older copy kept starting that
; copy, which offered the same update every time. (A first install run from a packaged app, such as the
; Claude desktop app, lands in that app's redirected folder under AppData\Local\Packages.)
!macro SKETCH_FIX_SHORTCUT LNK
  ${If} ${FileExists} "${LNK}"
    !insertmacro IsShortcutTarget "${LNK}" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 0
      !insertmacro SetShortcutTarget "${LNK}" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
  ${EndIf}
!macroend

; The launcher layout (Silent Updates, F6): the install folder holds the launcher as sketch.exe,
; current.json naming the version folder to start, and one app-<short commit> folder per version with
; that build's sketch.exe and sketch-capture.exe (src-tauri/src/layout.rs). Tauri copies the package's
; three programs (sketch.exe, sketch-capture.exe, sketch-launcher.exe) into $INSTDIR, and
; NSIS_HOOK_POSTINSTALL rearranges them. Everything outside (shortcuts, Explorer's verbs, file types,
; the uninstall entry) keeps pointing at $INSTDIR\sketch.exe, which is now the launcher. Updates after
; that never run the installer: the update build stages each new version folder itself.
;
; The first version folder is named after the build's commit, from version.nsh, which
; scripts/build-info.mjs writes before each build (npm run build).
!include /NONFATAL "${__FILEDIR__}\version.nsh"
!ifndef SKETCH_VERSION_FOLDER
  !error "src-tauri/windows/version.nsh is missing. Build with npm run tauri build, whose npm run build writes it."
!endif

; The capture helper's sign-in entry (src-tauri/src/helper.rs).
!define SKETCH_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

; Tells every running capture helper to quit (its hidden window's class is SketchCaptureHelper), so
; its file can be replaced or deleted. Each quits as soon as its window closes.
!macro SKETCH_STOP_HELPERS
  StrCpy $R9 0
  ${Do}
    FindWindow $R8 "SketchCaptureHelper"
    ${If} $R8 = 0
    ${OrIf} $R9 > 30
      ${Break}
    ${EndIf}
    SendMessage $R8 16 0 0 /TIMEOUT=2000 ; WM_CLOSE
    Sleep 100
    IntOp $R9 $R9 + 1
  ${Loop}
  ; The window goes a moment before the process lets go of its file.
  Sleep 300
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SKETCH_STOP_HELPERS
!macroend

; Moves one of the programs Tauri copied into $INSTDIR into the version folder ($R7). Reinstalling the
; same build finds its folder already there, and maybe in use: the running copy is the same build, so
; it stays and the new copy goes.
!macro SKETCH_INTO_VERSION EXE
  Delete "$R7\${EXE}"
  ${If} ${FileExists} "$R7\${EXE}"
    Delete "$INSTDIR\${EXE}"
  ${Else}
    Rename "$INSTDIR\${EXE}" "$R7\${EXE}"
  ${EndIf}
!macroend

; Sets up the launcher layout in $INSTDIR from the three programs Tauri copied there, and leaves the
; version folder in $R7. A Sketch from before it (one sketch.exe in $INSTDIR) becomes the same.
; check:update runs it against a scratch folder.
!macro SKETCH_LAYOUT
  StrCpy $R7 "$INSTDIR\${SKETCH_VERSION_FOLDER}"
  CreateDirectory "$R7"
  !insertmacro SKETCH_INTO_VERSION "${MAINBINARYNAME}.exe"
  !insertmacro SKETCH_INTO_VERSION "sketch-capture.exe"
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  Rename "$INSTDIR\sketch-launcher.exe" "$INSTDIR\${MAINBINARYNAME}.exe"
  ; builtAt first: the launcher reads it with a plain text search.
  FileOpen $R8 "$R7\version.json" w
  FileWrite $R8 '{"builtAt": "${SKETCH_BUILT_AT}", "commit": "${SKETCH_COMMIT}"}'
  FileClose $R8
  ; Written last and whole, so the launcher never reads half of it.
  FileOpen $R8 "$INSTDIR\current.json.part" w
  FileWrite $R8 '{"folder": "${SKETCH_VERSION_FOLDER}", "commit": "${SKETCH_COMMIT}", "previous": ""}'
  FileClose $R8
  Delete "$INSTDIR\current.json"
  Rename "$INSTDIR\current.json.part" "$INSTDIR\current.json"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SKETCH_LAYOUT
  ; When capture has keys, the sign-in entry starts the newest helper through the launcher, and this
  ; version's helper starts straight away.
  ReadRegStr $0 HKCU "${SKETCH_RUN_KEY}" "Sketch Capture"
  ${If} $0 != ""
    WriteRegStr HKCU "${SKETCH_RUN_KEY}" "Sketch Capture" '"$INSTDIR\${MAINBINARYNAME}.exe" --capture-helper'
    Exec '"$R7\sketch-capture.exe"'
  ${EndIf}
  !insertmacro SKETCH_FIX_SHORTCUT "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro SKETCH_FIX_SHORTCUT "$DESKTOP\${PRODUCTNAME}.lnk"
  !insertmacro SKETCH_FIX_SHORTCUT "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${PRODUCTNAME}.lnk"
  !insertmacro SKETCH_FIX_SHORTCUT "$SMPROGRAMS\Paste into Sketch.lnk"
  !insertmacro SKETCH_FIX_SHORTCUT "$SMPROGRAMS\Capture with Sketch.lnk"
  WriteRegStr SHCTX "Software\Classes\Sketch.Picture" "" "Picture"
  WriteRegStr SHCTX "Software\Classes\Sketch.Picture\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\Sketch.Picture\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".sktch" ""
  WriteRegStr SHCTX "Software\Sketch\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Sketch\Capabilities" "ApplicationDescription" "A fast, simple paint app"
  WriteRegStr SHCTX "Software\Sketch\Capabilities\FileAssociations" ".sktch" "Sketch.Document"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "Software\Sketch\Capabilities"
  !insertmacro SKETCH_PICTURE_TYPE "png"
  !insertmacro SKETCH_PICTURE_TYPE "jpg"
  !insertmacro SKETCH_PICTURE_TYPE "jpeg"
  !insertmacro SKETCH_PICTURE_TYPE "webp"
  !insertmacro SKETCH_PICTURE_TYPE "bmp"
  !insertmacro SKETCH_PICTURE_TYPE "gif"
  ; Tells Explorer the file types changed, so the menus update without a restart.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; Removes every version folder and the launcher's files (check:update runs it against a scratch folder).
!macro SKETCH_REMOVE_VERSIONS
  ; A fresh search after each removal, at most 100 rounds in case one can't be removed.
  StrCpy $R4 0
  ${Do}
    FindFirst $R6 $R5 "$INSTDIR\app-*"
    FindClose $R6
    ${If} $R5 == ""
    ${OrIf} $R4 > 100
      ${Break}
    ${EndIf}
    RMDir /r "$INSTDIR\$R5"
    IntOp $R4 $R4 + 1
  ${Loop}
  StrCpy $R4 0
  ${Do}
    FindFirst $R6 $R5 "$INSTDIR\.trash-*"
    FindClose $R6
    ${If} $R5 == ""
    ${OrIf} $R4 > 100
      ${Break}
    ${EndIf}
    RMDir /r "$INSTDIR\$R5"
    IntOp $R4 $R4 + 1
  ${Loop}
  Delete "$INSTDIR\current.json"
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.old"
  Delete "$INSTDIR\sketch-launcher.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SKETCH_STOP_HELPERS
  Delete "$INSTDIR\sketch-capture.exe"
  ; An update runs the old uninstaller with /UPDATE: keep everything, the new install writes it again.
  ${If} $UpdateMode <> 1
    ; Every version goes. Tauri's own running-app check only sees the launcher, so a Sketch running
    ; from a version folder is closed here first (asking, as Tauri's check does).
    FindFirst $R6 $R5 "$INSTDIR\app-*"
    ${DoWhile} $R5 != ""
      ${If} ${FileExists} "$INSTDIR\$R5\${MAINBINARYNAME}.exe"
        StrCpy $R4 "$INSTDIR\$R5\${MAINBINARYNAME}.exe"
        !insertmacro CheckIfAppIsRunning "$R4" "${PRODUCTNAME}"
      ${EndIf}
      FindNext $R6 $R5
    ${Loop}
    FindClose $R6
    !insertmacro SKETCH_REMOVE_VERSIONS
    !insertmacro SKETCH_REMOVE_PICTURE_TYPE "png"
    !insertmacro SKETCH_REMOVE_PICTURE_TYPE "jpg"
    !insertmacro SKETCH_REMOVE_PICTURE_TYPE "jpeg"
    !insertmacro SKETCH_REMOVE_PICTURE_TYPE "webp"
    !insertmacro SKETCH_REMOVE_PICTURE_TYPE "bmp"
    !insertmacro SKETCH_REMOVE_PICTURE_TYPE "gif"
    DeleteRegKey SHCTX "Software\Classes\Sketch.Picture"
    DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
    DeleteRegKey SHCTX "Software\Sketch"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
    ; The "Paste into Sketch" shortcut Settings can make, the capture shortcut older versions made, and
    ; the capture helper's sign-in entry.
    Delete "$SMPROGRAMS\Paste into Sketch.lnk"
    Delete "$SMPROGRAMS\Capture with Sketch.lnk"
    DeleteRegValue HKCU "${SKETCH_RUN_KEY}" "Sketch Capture"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
