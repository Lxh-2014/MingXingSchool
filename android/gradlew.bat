@rem ----------------------------------------------------------------------------
@rem Gradle wrapper startup script for Windows.
@rem Downloads the Gradle distribution declared in gradle-wrapper.properties
@rem on first run, so a local Gradle installation is not required.
@rem NOTE: keep this file ASCII-only and CRLF, otherwise cmd may misparse it.
@rem ----------------------------------------------------------------------------
@if "%DEBUG%"=="" @echo off
@rem Use a local scope so variables do not leak into the caller
setlocal

@rem Directory of this script (project root), with trailing backslash
set DIRNAME=%~dp0
if "%DIRNAME%"=="" set DIRNAME=.
@rem Script name, used by Gradle for the process title
set APP_BASE_NAME=%~n0
set APP_HOME=%DIRNAME%

@rem JVM options for the wrapper itself: keep memory usage small
set DEFAULT_JVM_OPTS="-Xmx64m" "-Xms64m"

@rem Prefer the JDK from JAVA_HOME; fall back to java on PATH
if defined JAVA_HOME goto findJavaFromJavaHome

set JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
if %ERRORLEVEL% equ 0 goto execute

echo ERROR: JAVA_HOME is not set and no java command was found in PATH. 1>&2
echo Install JDK 17 and set JAVA_HOME to its install directory. 1>&2
goto fail

:findJavaFromJavaHome
set JAVA_HOME=%JAVA_HOME:"=%
set JAVA_EXE=%JAVA_HOME%/bin/java.exe

if exist "%JAVA_EXE%" goto execute

echo ERROR: JAVA_HOME points to an invalid directory: %JAVA_HOME% 1>&2
echo Point JAVA_HOME to a JDK 17 install directory. 1>&2
goto fail

:execute
@rem Classpath holds only the wrapper jar; Gradle itself is downloaded by it
set CLASSPATH=%APP_HOME%\gradle\wrapper\gradle-wrapper.jar

"%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*

:end
@rem Expand ERRORLEVEL before endlocal in the same line to keep Gradle's exit code
@endlocal & exit /b %ERRORLEVEL%

:fail
@endlocal & exit /b 1
