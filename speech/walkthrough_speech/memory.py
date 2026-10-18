"""Memory reporting and release.

On Apple silicon GPU allocations live in unified memory and are not fully
visible in RSS, so we also report the kernel's phys_footprint (current and
lifetime peak) via proc_pid_rusage, plus the framework's own counters.
"""

from __future__ import annotations

import ctypes
import os
import sys

import psutil


class _RusageInfoV4(ctypes.Structure):
    _fields_ = [
        ("ri_uuid", ctypes.c_uint8 * 16),
        ("ri_user_time", ctypes.c_uint64),
        ("ri_system_time", ctypes.c_uint64),
        ("ri_pkg_idle_wkups", ctypes.c_uint64),
        ("ri_interrupt_wkups", ctypes.c_uint64),
        ("ri_pageins", ctypes.c_uint64),
        ("ri_wired_size", ctypes.c_uint64),
        ("ri_resident_size", ctypes.c_uint64),
        ("ri_phys_footprint", ctypes.c_uint64),
        ("ri_proc_start_abstime", ctypes.c_uint64),
        ("ri_proc_exit_abstime", ctypes.c_uint64),
        ("ri_child_user_time", ctypes.c_uint64),
        ("ri_child_system_time", ctypes.c_uint64),
        ("ri_child_pkg_idle_wkups", ctypes.c_uint64),
        ("ri_child_interrupt_wkups", ctypes.c_uint64),
        ("ri_child_pageins", ctypes.c_uint64),
        ("ri_child_elapsed_abstime", ctypes.c_uint64),
        ("ri_diskio_bytesread", ctypes.c_uint64),
        ("ri_diskio_byteswritten", ctypes.c_uint64),
        ("ri_cpu_time_qos_default", ctypes.c_uint64),
        ("ri_cpu_time_qos_maintenance", ctypes.c_uint64),
        ("ri_cpu_time_qos_background", ctypes.c_uint64),
        ("ri_cpu_time_qos_utility", ctypes.c_uint64),
        ("ri_cpu_time_qos_legacy", ctypes.c_uint64),
        ("ri_cpu_time_qos_user_initiated", ctypes.c_uint64),
        ("ri_cpu_time_qos_user_interactive", ctypes.c_uint64),
        ("ri_billed_system_time", ctypes.c_uint64),
        ("ri_serviced_system_time", ctypes.c_uint64),
        ("ri_logical_writes", ctypes.c_uint64),
        ("ri_lifetime_max_phys_footprint", ctypes.c_uint64),
        ("ri_instructions", ctypes.c_uint64),
        ("ri_cycles", ctypes.c_uint64),
        ("ri_billed_energy", ctypes.c_uint64),
        ("ri_serviced_energy", ctypes.c_uint64),
        ("ri_interval_max_phys_footprint", ctypes.c_uint64),
        ("ri_runnable_time", ctypes.c_uint64),
    ]


def _footprint() -> dict:
    if sys.platform != "darwin":
        return {}
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    info = _RusageInfoV4()
    if libc.proc_pid_rusage(os.getpid(), 4, ctypes.byref(info)) != 0:
        return {}
    return {
        "footprintBytes": info.ri_phys_footprint,
        "peakFootprintBytes": info.ri_lifetime_max_phys_footprint,
    }


def snapshot(engine_name: str | None) -> dict:
    out = {"rssBytes": psutil.Process().memory_info().rss, **_footprint()}
    if "mlx.core" in sys.modules:
        mx = sys.modules["mlx.core"]
        try:
            out["mlxPeakBytes"] = mx.get_peak_memory()
            out["mlxActiveBytes"] = mx.get_active_memory()
        except AttributeError:
            pass
    if "torch" in sys.modules:
        torch = sys.modules["torch"]
        try:
            if torch.backends.mps.is_available():
                out["mpsDriverBytes"] = torch.mps.driver_allocated_memory()
        except Exception:
            pass
    out["engine"] = engine_name
    return out


def release(engine_name: str | None) -> None:
    if "mlx.core" in sys.modules:
        try:
            sys.modules["mlx.core"].clear_cache()
        except AttributeError:
            pass
    if "torch" in sys.modules:
        torch = sys.modules["torch"]
        try:
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
        except Exception:
            pass
