on run
    set appBundle to POSIX path of (path to me)
    set installationPath to appBundle & "Contents/Resources/installation.json"
    set runtimePath to "__RUNTIME__"
    set sourcePath to "__SOURCE__"
    set invocation to quoted form of runtimePath & " " & quoted form of sourcePath & " --launch --installation " & quoted form of installationPath
    try
        do shell script invocation
    on error problemText number problemNumber
        display dialog "Lovefield Tree Study could not open. " & problemText buttons {"OK"} default button "OK" with icon stop
    end try
end run
