@rem Standard Gradle wrapper launcher for Windows. Requires gradle-wrapper.jar,
@rem which is a binary this build environment cannot author — see SETUP-MOBILE.md.
@rem Regenerate it with `gradle wrapper` once Gradle/Android Studio is available,
@rem or simply open this project in Android Studio, which does it automatically.
@echo off
set DIR=%~dp0
set JAVA_EXE=java.exe
"%JAVA_EXE%" -cp "%DIR%gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
