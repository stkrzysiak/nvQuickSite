// Copyright (c) 2016-2020 nvisionative, Inc.
//
// This file is part of nvQuickSite.
//
// nvQuickSite is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// nvQuickSite is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with nvQuickSite.  If not, see <http://www.gnu.org/licenses/>.

namespace nvQuickSite
{
    using System;
    using System.Diagnostics;
    using System.Linq;
    using System.Runtime.InteropServices;
    using System.Security.Principal;
    using System.Windows.Forms;

    using nvQuickSite.Controllers;
    using Serilog;
    using Serilog.Core;
    using Serilog.Events;

    /// <summary>
    /// Implements the program entry point.
    /// </summary>
    public static class Program
    {
        private const int AttachParentProcess = -1;
        private const int StdOutputHandle = -11;
        private const int FileTypeDisk = 1;
        private const int FileTypePipe = 3;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        /// <summary>
        /// The main entry point for the application.
        /// </summary>
        /// <param name="args">The command line arguments.</param>
        /// <returns>The process exit code.</returns>
        [STAThread]
        private static int Main(string[] args)
        {
            return CommandLineController.IsCommandLineMode(args)
                ? RunCommandLine(args)
                : RunUserInterface();
        }

        private static int RunUserInterface()
        {
            var loggingLevelSwitch = new LoggingLevelSwitch();
            var log = CreateLogger(loggingLevelSwitch, LogEventLevel.Information, true);
            log.Information("Application Started v{version}", Application.ProductVersion);
            Log.Logger = log;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (!IsElevated())
            {
                log.Information("Starting as an administrator.");
                var startInfo = new ProcessStartInfo
                {
                    Verb = "runas",
                    FileName = Application.ExecutablePath,
                };
                Process.Start(startInfo);
                return 0;
            }

            using (var main = new Main(loggingLevelSwitch))
            {
                Application.Run(main);
            }

            return 0;
        }

        private static int RunCommandLine(string[] args)
        {
            var allocatedConsole = AttachToConsole();
            try
            {
                var verbose = args.Any(arg => string.Equals(arg, "--verbose", StringComparison.OrdinalIgnoreCase));
                Log.Logger = CreateLogger(new LoggingLevelSwitch(), verbose ? LogEventLevel.Debug : LogEventLevel.Information, verbose);
                Log.Logger.Information("Application started in command line mode v{version}", Application.ProductVersion);
                return CommandLineController.Run(args);
            }
            finally
            {
                Log.CloseAndFlush();
                if (allocatedConsole)
                {
                    Console.Out.WriteLine();
                    Console.Out.Write("Press any key to close this window . . . ");
                    Console.ReadKey(true);
                }
                else
                {
                    // The parent shell already printed its prompt, so leave the cursor on a fresh line.
                    Console.Out.WriteLine();
                }
            }
        }

        private static Logger CreateLogger(LoggingLevelSwitch loggingLevelSwitch, LogEventLevel minimumLevel, bool writeToConsole)
        {
            loggingLevelSwitch.MinimumLevel = minimumLevel;
            var configuration = new LoggerConfiguration()
                .MinimumLevel.ControlledBy(loggingLevelSwitch)
                .WriteTo.File(
                    path: "Logs\\log-.txt",
                    rollingInterval: RollingInterval.Day)
                .WriteTo.Debug();

            if (writeToConsole)
            {
                configuration = configuration.WriteTo.Console();
            }

            return configuration.CreateLogger();
        }

        private static bool IsElevated()
        {
            var principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
            Log.Logger.Debug("Current user is {@principal}", principal.Identity.Name);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }

        /// <summary>
        /// Gives this Windows application a console to write to.
        /// </summary>
        /// <returns>True when a new console window had to be created, meaning nothing will read its output once the process exits.</returns>
        private static bool AttachToConsole()
        {
            if (IsOutputRedirected())
            {
                // Standard output already goes to a file or a pipe (a script,
                // ssh, CI). Attaching a console would overwrite the redirected
                // handles and silently discard every line written.
                return false;
            }

            if (AttachConsole(AttachParentProcess))
            {
                return false;
            }

            AllocConsole();
            return true;
        }

        private static bool IsOutputRedirected()
        {
            var handle = GetStdHandle(StdOutputHandle);
            if (handle == IntPtr.Zero || handle == InvalidHandleValue)
            {
                return false;
            }

            var fileType = GetFileType(handle);
            return fileType == FileTypeDisk || fileType == FileTypePipe;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AttachConsole(int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AllocConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int stdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern int GetFileType(IntPtr handle);
    }
}
