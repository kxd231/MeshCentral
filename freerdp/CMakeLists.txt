cmake_minimum_required(VERSION 3.16)
project(meshfreerdp LANGUAGES C)

find_package(PkgConfig REQUIRED)
pkg_check_modules(FREERDP REQUIRED IMPORTED_TARGET freerdp3 freerdp-client3 winpr3)
pkg_check_modules(TURBOJPEG REQUIRED IMPORTED_TARGET libturbojpeg)

add_executable(meshfreerdp meshfreerdp.c)
set_target_properties(meshfreerdp PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)
target_compile_options(meshfreerdp PRIVATE -Wall -Wextra)
target_link_libraries(meshfreerdp PRIVATE PkgConfig::FREERDP PkgConfig::TURBOJPEG)
# musl (Alpine) gives new threads a 128 KiB stack. FreeRDP decodes GFX (H.264, progressive) on its
# channel threads, which needs much more. musl takes the default thread stack size from PT_GNU_STACK.
target_link_options(meshfreerdp PRIVATE -Wl,-z,stack-size=8388608)
