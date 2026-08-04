!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "getProcessInfo.nsh"

Var pid

!define SKILLCUE_PERSISTENT_DATA "$APPDATA\@interview\desktop\backend-data"

!macro SkillCueMigrateDatabase SOURCE_DIR
  ${IfNot} ${FileExists} "${SKILLCUE_PERSISTENT_DATA}\copilot.sqlite"
    ${If} ${FileExists} "${SOURCE_DIR}\copilot.sqlite"
      DetailPrint "Preserving SkillCue resume and history..."
      CreateDirectory "${SKILLCUE_PERSISTENT_DATA}"
      CopyFiles /SILENT "${SOURCE_DIR}\copilot.sqlite" "${SKILLCUE_PERSISTENT_DATA}\copilot.sqlite"
      ${If} ${FileExists} "${SOURCE_DIR}\copilot.sqlite-wal"
        CopyFiles /SILENT "${SOURCE_DIR}\copilot.sqlite-wal" "${SKILLCUE_PERSISTENT_DATA}\copilot.sqlite-wal"
      ${EndIf}
      ${If} ${FileExists} "${SOURCE_DIR}\copilot.sqlite-shm"
        CopyFiles /SILENT "${SOURCE_DIR}\copilot.sqlite-shm" "${SKILLCUE_PERSISTENT_DATA}\copilot.sqlite-shm"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !insertmacro _CHECK_APP_RUNNING

  ; Preserve databases from both the registered install path and the legacy
  ; desktop install used by earlier SkillCue builds. This runs after SkillCue
  ; has stopped and before electron-builder removes the old installation.
  !insertmacro SkillCueMigrateDatabase "$INSTDIR\resources\backend\_internal\data"
  !insertmacro SkillCueMigrateDatabase "$INSTDIR\resources\backend\data"
  !insertmacro SkillCueMigrateDatabase "$DESKTOP\Skillcue\resources\backend\_internal\data"
  !insertmacro SkillCueMigrateDatabase "$DESKTOP\Skillcue\resources\backend\data"
  !insertmacro SkillCueMigrateDatabase "$LOCALAPPDATA\Programs\Skillcue\resources\backend\_internal\data"
  !insertmacro SkillCueMigrateDatabase "$LOCALAPPDATA\Programs\Skillcue\resources\backend\data"
!macroend
