; Wurster file-type verification verbs.
; These verbs are scoped only to Wurster-owned .wurst/.wrst ProgIDs.

!macro customInstall
  !insertmacro APP_ASSOCIATE_ADDVERB "Wurster.Wurst" "VerifyWurstIdentity" "Verify Wurst Identity" "$\"$INSTDIR\Wurster.exe$\" --verify-wurst-identity $\"%1$\""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Wurster.Wurst\shell\VerifyWurstIdentity" "Icon" "$INSTDIR\Wurster.exe,0"
  !insertmacro APP_ASSOCIATE_ADDVERB "Wurster.Wrst" "VerifyWurstIdentity" "Verify Wurst Identity" "$\"$INSTDIR\Wurster.exe$\" --verify-wurst-identity $\"%1$\""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Wurster.Wrst\shell\VerifyWurstIdentity" "Icon" "$INSTDIR\Wurster.exe,0"
!macroend

!macro customUnInstall
  !insertmacro APP_ASSOCIATE_REMOVEVERB "Wurster.Wurst" "VerifyWurstIdentity"
  !insertmacro APP_ASSOCIATE_REMOVEVERB "Wurster.Wrst" "VerifyWurstIdentity"
!macroend
