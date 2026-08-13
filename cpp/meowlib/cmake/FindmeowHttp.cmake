# meowHttp is fetched via FetchContent as a sibling dependency of MeowLib.
# MeowLib's CMakeLists does find_package(meowHttp REQUIRED); when the target
# already exists in-tree, just report it as found instead of re-importing it.
if(TARGET meowHttp)
  set(meowHttp_FOUND TRUE)
else()
  find_package(meowHttp CONFIG QUIET)
endif()
