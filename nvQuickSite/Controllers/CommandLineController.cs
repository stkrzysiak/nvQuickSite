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

namespace nvQuickSite.Controllers
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Linq;
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    using System.Security.Principal;
    using System.Threading;

    using Microsoft.Web.Administration;
    using nvQuickSite.Controllers.Exceptions;
    using nvQuickSite.Models;
    using Serilog;

    /// <summary>
    /// Runs nvQuickSite headlessly from the command line, driving the same controllers as the wizard.
    /// </summary>
    internal static class CommandLineController
    {
        /// <summary>The command completed successfully.</summary>
        internal const int ExitSuccess = 0;

        /// <summary>The command failed while doing its work.</summary>
        internal const int ExitFailure = 1;

        /// <summary>The command line could not be understood.</summary>
        internal const int ExitUsage = 2;

        private const string DefaultDatabaseServer = "(local)";
        private const string ReleaseCandidatePackageId = "dnn-platform-rc";

        /// <summary>
        /// Gets a value indicating whether the arguments ask for command line mode.
        /// </summary>
        /// <param name="args">The raw command line arguments.</param>
        /// <returns>True when the process should run as a console application.</returns>
        internal static bool IsCommandLineMode(string[] args)
        {
            return args != null && args.Any(IsCommandLineSwitch);
        }

        /// <summary>
        /// Executes the requested command.
        /// </summary>
        /// <param name="args">The raw command line arguments, including the <c>--cli</c> switch.</param>
        /// <returns>The process exit code.</returns>
        internal static int Run(string[] args)
        {
            var remaining = args.Where(arg => !IsCommandLineSwitch(arg)).ToArray();

            var command = remaining.FirstOrDefault();
            if (command != null && command.StartsWith("-", StringComparison.Ordinal))
            {
                command = null;
            }

            var options = new Options(remaining);

            var helpRequested = options.HasFlag("help") || options.HasFlag("h") || options.HasFlag("?");
            if (command == null || helpRequested)
            {
                WriteHelp(command);
                return helpRequested ? ExitSuccess : ExitUsage;
            }

            // Relaunching elevated would detach the console and lose the output, so ask the user to do it instead.
            if (!IsElevated())
            {
                Error("nvQuickSite needs administrative rights to configure IIS, SQL Server and the hosts file.");
                Error("Re-run this command from an elevated command prompt.");
                return ExitFailure;
            }

            try
            {
                switch (command.ToLowerInvariant())
                {
                    case "install":
                        return Install(options);
                    case "list":
                        return List(options);
                    case "delete":
                    case "remove":
                        return Delete(options);
                    case "packages":
                        return Packages(options);
                    default:
                        Error($"Unknown command '{command}'.");
                        WriteHelp(null);
                        return ExitUsage;
                }
            }
            catch (UsageException ex)
            {
                Error(ex.Message);
                WriteHelp(command);
                return ExitUsage;
            }
            catch (SiteExistsException ex)
            {
                return Fail(ex, "Use --delete-existing-site to replace the existing site.");
            }
            catch (Exception ex)
            {
                // The controllers set Source to the title the wizard would have shown, which Fail reports.
                return Fail(ex, null);
            }
        }

        private static bool IsCommandLineSwitch(string arg)
        {
            return string.Equals(arg, "--cli", StringComparison.OrdinalIgnoreCase)
                || string.Equals(arg, "-cli", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsElevated()
        {
            var principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
            Log.Logger.Debug("Current user is {@principal}", principal.Identity.Name);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }

        private static int Install(Options options)
        {
            var siteName = options.Require("site");
            var installFolder = Path.GetFullPath(options.Require("install-folder"));
            var databaseServer = options.Get("db-server", DefaultDatabaseServer).Trim();
            var databaseName = options.Get("db-name", siteName.Split('.')[0]);
            var databaseUser = options.Get("db-user", string.Empty);
            var databasePassword = options.Get("db-password", string.Empty);
            var useWindowsAuthentication = string.IsNullOrEmpty(databaseUser);
            var useSiteSpecificAppPool = !options.HasFlag("no-app-pool");
            var deleteExistingSite = options.HasFlag("delete-existing-site");
            var force = options.HasFlag("force");
            var skipDatabase = options.HasFlag("skip-db");

            if (!useWindowsAuthentication && string.IsNullOrEmpty(databasePassword))
            {
                throw new UsageException("--db-password is required when --db-user is specified.");
            }

            var certificate = options.HasFlag("ssl")
                ? FindCertificate(options.Get("certificate", null))
                : null;

            // Validate the destination before spending time on a download.
            PrepareInstallFolder(installFolder, force);

            var packagePath = ResolvePackage(options, force);

            Info($"Creating IIS site {siteName}");
            IISController.CreateSite(siteName, installFolder, useSiteSpecificAppPool, deleteExistingSite, certificate);

            Info("Updating the hosts file");
            FileSystemController.UpdateHostsFile(siteName);

            Info($"Creating directories under {installFolder}");
            FileSystemController.CreateDirectories(
                installFolder,
                siteName,
                useSiteSpecificAppPool,
                databaseServer,
                databaseServer,
                useWindowsAuthentication,
                databaseUser,
                databasePassword,
                createDatabaseFolder: !skipDatabase);

            if (skipDatabase)
            {
                // The caller owns the database (e.g. it lives on a server that
                // does not speak full T-SQL, like Babelfish for PostgreSQL,
                // where SetDatabasePermissions' sp_grantlogin does not exist).
                // The db options still flow into web.config below.
                Info("Skipping database creation (--skip-db)");
            }
            else
            {
                Info($"Creating database {databaseName} on {databaseServer}");
                var databaseController = new DatabaseController(
                    databaseName,
                    databaseServer,
                    useWindowsAuthentication,
                    databaseUser,
                    databasePassword,
                    installFolder,
                    useSiteSpecificAppPool,
                    siteName);
                databaseController.CreateDatabase();
                databaseController.SetDatabasePermissions();
            }

            Info($"Extracting {Path.GetFileName(packagePath)}");
            ExtractPackage(packagePath, Path.Combine(installFolder, "Website"));

            Info("Updating web.config");
            FileSystemController.ModifyConfig(
                databaseServer,
                useWindowsAuthentication,
                databaseUser,
                databasePassword,
                databaseName,
                installFolder);

            var url = (certificate == null ? "http://" : "https://") + siteName;
            Log.Logger.Information("Site {siteName} ready to visit", siteName);
            Info(string.Empty);
            Info($"Done. Finish the DNN installation wizard at {url}");
            return ExitSuccess;
        }

        private static int List(Options options)
        {
            var sites = GetSites(options.HasFlag("all")).ToList();
            if (sites.Count == 0)
            {
                Info("No sites found.");
                return ExitSuccess;
            }

            var nameWidth = Math.Max(9, sites.Max(s => s.Name.Length));
            var poolWidth = Math.Max(16, sites.Max(s => s.ApplicationPool.Length));
            Info($"{"ID",4}  {"SITE NAME".PadRight(nameWidth)}  {"APPLICATION POOL".PadRight(poolWidth)}  {"STATE",-8}  PATH");
            foreach (var site in sites)
            {
                Info($"{site.Id,4}  {site.Name.PadRight(nameWidth)}  {site.ApplicationPool.PadRight(poolWidth)}  {site.State,-8}  {site.PhysicalPath}");
            }

            return ExitSuccess;
        }

        private static int Delete(Options options)
        {
            var siteName = options.Require("site");
            if (!options.HasFlag("yes"))
            {
                Error($"Deleting {siteName} removes its IIS site, application pool, database, files and hosts entry. Re-run with --yes to confirm.");
                return ExitUsage;
            }

            var site = GetSites(true).FirstOrDefault(s => string.Equals(s.Name, siteName, StringComparison.OrdinalIgnoreCase));
            if (site == null)
            {
                Error($"No site created by nvQuickSite is named '{siteName}'. Run 'list' to see the available sites.");
                return ExitFailure;
            }

            if (string.IsNullOrEmpty(site.PhysicalPath))
            {
                Error($"'{siteName}' has no root application, so nvQuickSite cannot tell which files belong to it.");
                return ExitFailure;
            }

            var databaseServer = options.Get("db-server", Properties.Settings.Default.DatabaseServerNameRecent);
            if (string.IsNullOrWhiteSpace(databaseServer))
            {
                databaseServer = DefaultDatabaseServer;
            }

            var databaseName = options.Get("db-name", site.Name.Split('.')[0]);
            var databaseUser = options.Get("db-user", string.Empty);
            var databasePassword = options.Get("db-password", string.Empty);
            var useWindowsAuthentication = string.IsNullOrEmpty(databaseUser);
            var installFolder = Directory.GetParent(site.PhysicalPath).FullName;

            // Every removal below runs even when an earlier one fails: a
            // failed database drop used to abort the whole command and leave
            // the IIS site, files and hosts entry behind with nothing but a
            // stderr line to show for it. Now each step is attempted, the
            // failures are listed together, and the exit code reports them.
            var failures = new List<string>();

            Attempt(failures, $"Stopping site {site.Name}", () =>
            {
                IISController.StopSite(site.Id, null);
                IISController.StopAppPool(site.Id, null);
            });

            Attempt(failures, $"Deleting database {databaseName}", () =>
                new DatabaseController(
                    databaseName,
                    databaseServer,
                    useWindowsAuthentication,
                    databaseUser,
                    databasePassword,
                    installFolder,
                    true,
                    site.Name)
                    .DeleteDatabase(null));

            Attempt(failures, $"Deleting files at {site.PhysicalPath}", () => DeleteSiteFiles(site.PhysicalPath));

            Attempt(failures, "Removing the hosts file entry", () => FileSystemController.RemoveHostEntry(site.Name));

            Attempt(failures, "Deleting the IIS site", () => IISController.DeleteSite(site.Id, null));

            Attempt(failures, $"Deleting application pool {site.ApplicationPool}", () =>
            {
                try
                {
                    IISController.DeleteAppPool(site.ApplicationPool, null);
                }
                catch (ArgumentException ex)
                {
                    // The pool may still be shared with another site, which is not fatal.
                    Log.Logger.Warning(ex, "Could not delete application pool {appPool}", site.ApplicationPool);
                    Error($"Could not delete application pool {site.ApplicationPool}: {ex.Message}");
                }
            });

            if (failures.Count > 0)
            {
                Error($"{site.Name} was only partially deleted:");
                foreach (var failure in failures)
                {
                    Error($"  {failure}");
                }

                return ExitFailure;
            }

            Info($"{site.Name} has been deleted. Its Logs and Database folders remain under {installFolder}.");
            return ExitSuccess;
        }

        private static void Attempt(List<string> failures, string action, Action work)
        {
            Info(action);
            try
            {
                work();
            }
            catch (Exception ex)
            {
                var message = string.IsNullOrEmpty(ex.Source) ? ex.Message : $"{ex.Source}: {ex.Message}";
                Log.Logger.Error(ex, "{action} failed", action);
                Error($"{action} failed: {message}");
                failures.Add($"{action} failed: {message}");
            }
        }

        private static int Packages(Options options)
        {
            var packages = GetPackages(options.HasFlag("include-prereleases"))
                .OrderBy(p => p.did)
                .ThenByDescending(p => p.version)
                .ToList();

            if (packages.Count == 0)
            {
                Error("No packages are available. Check your internet connection.");
                return ExitFailure;
            }

            var idWidth = packages.Max(p => p.did.Length);
            foreach (var package in packages)
            {
                Info($"{package.did.PadRight(idWidth)}  {package.version}");
            }

            return ExitSuccess;
        }

        private static string ResolvePackage(Options options, bool force)
        {
            var localPackage = options.Get("local-package", null);
            if (localPackage != null)
            {
                localPackage = Path.GetFullPath(localPackage);
                if (!File.Exists(localPackage))
                {
                    throw new UsageException($"The install package '{localPackage}' does not exist.");
                }

                return localPackage;
            }

            var packageId = options.Get("package", null);
            var versionText = options.Get("version", null);
            var packages = GetPackages(options.HasFlag("include-prereleases") || packageId == ReleaseCandidatePackageId).ToList();
            if (packages.Count == 0)
            {
                throw new UsageException("No packages are available to download. Use --local-package to install from a local file.");
            }

            if (packageId == null)
            {
                packageId = packages.OrderByDescending(p => p.version).First().did;
            }

            var candidates = packages.Where(p => p.did == packageId).OrderByDescending(p => p.version).ToList();
            if (candidates.Count == 0)
            {
                throw new UsageException($"Unknown package '{packageId}'. Run the 'packages' command to see what is available.");
            }

            Package package;
            if (versionText == null)
            {
                package = candidates.First();
            }
            else
            {
                System.Version version;
                if (!System.Version.TryParse(versionText, out version))
                {
                    throw new UsageException($"'{versionText}' is not a valid version.");
                }

                package = candidates.FirstOrDefault(p => p.version == version)
                    ?? candidates.FirstOrDefault(p =>
                        p.version.Major == version.Major &&
                        p.version.Minor == version.Minor &&
                        p.version.Build == version.Build);

                if (package == null)
                {
                    throw new UsageException($"Version {versionText} of '{packageId}' is not available. Run the 'packages' command to see what is available.");
                }
            }

            var downloadDirectory = FileSystemController.GetDownloadDirectory();
            Directory.CreateDirectory(downloadDirectory);
            var targetPath = Path.Combine(downloadDirectory, package.url.Split('/').Last());

            if (File.Exists(targetPath) && !force)
            {
                Info($"Using the already downloaded {Path.GetFileName(targetPath)} (--force re-downloads it).");
                return targetPath;
            }

            Download(package.url, targetPath);
            return targetPath;
        }

        private static IEnumerable<Package> GetPackages(bool includePrereleases)
        {
            try
            {
                var packages = PackageController.GetPackageList();
                return includePrereleases
                    ? packages
                    : packages.Where(p => p.did != ReleaseCandidatePackageId);
            }
            catch (WebException ex)
            {
                Log.Logger.Warning(ex, "Could not retrieve the package list");
                return Enumerable.Empty<Package>();
            }
        }

        private static void Download(string url, string targetPath)
        {
            Info($"Downloading {url}");
            Log.Logger.Information("Downloading package from {url}", url);

            using (var completed = new ManualResetEventSlim(false))
            using (var client = new WebClient())
            {
                Exception error = null;
                var lastPercent = -10;

                client.DownloadProgressChanged += (sender, e) =>
                {
                    if (e.ProgressPercentage >= lastPercent + 10)
                    {
                        lastPercent = e.ProgressPercentage;
                        Info($"  {e.ProgressPercentage}%");
                    }
                };

                client.DownloadFileCompleted += (sender, e) =>
                {
                    error = e.Error;
                    completed.Set();
                };

                client.DownloadFileAsync(new Uri(url), targetPath);
                completed.Wait();

                if (error != null)
                {
                    throw new InvalidOperationException($"Could not download {url}: {error.Message}", error);
                }
            }

            Log.Logger.Information("Completed download of {fileName}", Path.GetFileName(targetPath));
        }

        private static void ExtractPackage(string packagePath, string websiteFolder)
        {
            var extractor = new PackageExtractorController();
            var lastPercent = -10;
            extractor.ProgressUpdated += status => Log.Logger.Debug("{status}", status);
            extractor.ProgressValueUpdated += percent =>
            {
                if (percent >= lastPercent + 10)
                {
                    lastPercent = percent;
                    Info($"  {percent}%");
                }
            };

            extractor.ExtractPackage(packagePath, websiteFolder);
        }

        private static void PrepareInstallFolder(string installFolder, bool force)
        {
            if (!Directory.Exists(installFolder))
            {
                Directory.CreateDirectory(installFolder);
                return;
            }

            if (!FileSystemController.DirectoryEmpty(installFolder) && !force)
            {
                throw new UsageException(
                    $"The install folder '{installFolder}' is not empty. Its Website, Logs and Database folders will be deleted; re-run with --force to proceed.");
            }
        }

        private static void DeleteSiteFiles(string path)
        {
            try
            {
                FileSystemController.DeleteDirectory(path, null, true);
            }
            catch (IOException)
            {
                // Files may still be streaming (logs for instance) right after the site is stopped, so wait and retry once.
                Thread.Sleep(10000);
                FileSystemController.DeleteDirectory(path, null, true);
            }
        }

        private static X509Certificate2 FindCertificate(string nameOrThumbprint)
        {
            var certificates = IISController.GetSslCertificates();
            if (certificates.Count == 0)
            {
                throw new UsageException("No suitable SSL certificate was found in the local machine store.");
            }

            if (nameOrThumbprint == null)
            {
                var certificate = certificates[0];
                Info($"Using SSL certificate '{certificate.FriendlyName}'.");
                return certificate;
            }

            var match = certificates.FirstOrDefault(c =>
                string.Equals(c.FriendlyName, nameOrThumbprint, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(c.Thumbprint, nameOrThumbprint, StringComparison.OrdinalIgnoreCase));

            if (match == null)
            {
                throw new UsageException(
                    $"No certificate matches '{nameOrThumbprint}'. Available certificates: {string.Join(", ", certificates.Select(c => c.FriendlyName))}.");
            }

            return match;
        }

        /// <summary>
        /// Reads the sites out of IIS into detached values, because <see cref="IISController.GetSites"/>
        /// disposes the <see cref="ServerManager"/> that owns the returned objects.
        /// </summary>
        /// <param name="all">When true, includes sites that were not created by nvQuickSite.</param>
        /// <returns>The sites, ordered by name.</returns>
        private static IEnumerable<SiteInfo> GetSites(bool all)
        {
            using (var iisManager = new ServerManager())
            {
                return iisManager.Sites
                    .Where(s => all || s.ApplicationDefaults.ApplicationPoolName.EndsWith("_nvQuickSite", StringComparison.Ordinal))
                    .Select(s => new SiteInfo
                    {
                        Id = s.Id,
                        Name = s.Name,
                        ApplicationPool = s.ApplicationDefaults.ApplicationPoolName,
                        State = GetSiteState(s),
                        PhysicalPath = GetSitePhysicalPath(s),
                    })
                    .OrderBy(s => s.Name)
                    .ToList();
            }
        }

        private static string GetSiteState(Site site)
        {
            try
            {
                return site.State.ToString();
            }
            catch (Exception ex)
            {
                // Reading the state talks to the worker process, which fails when the site is misconfigured.
                Log.Logger.Debug(ex, "Could not read the state of {siteName}", site.Name);
                return "Unknown";
            }
        }

        private static string GetSitePhysicalPath(Site site)
        {
            var application = site.Applications["/"];
            if (application == null)
            {
                return string.Empty;
            }

            var virtualDirectory = application.VirtualDirectories["/"];
            return virtualDirectory == null ? string.Empty : virtualDirectory.PhysicalPath;
        }

        private static int Fail(Exception ex, string hint)
        {
            Log.Logger.Error(ex, "The command failed");
            Error(string.IsNullOrEmpty(ex.Source) ? ex.Message : $"{ex.Source}: {ex.Message}");
            if (hint != null)
            {
                Error(hint);
            }

            return ExitFailure;
        }

        private static void Info(string message)
        {
            Console.Out.WriteLine(message);
        }

        private static void Error(string message)
        {
            Console.Error.WriteLine(message);
        }

        private static void WriteHelp(string command)
        {
            switch (command == null ? string.Empty : command.ToLowerInvariant())
            {
                case "install":
                    Info("Usage: nvQuickSite --cli install --site <name> --install-folder <path> [options]");
                    Info(string.Empty);
                    Info("  --site <name>             Required. The site name and host header, e.g. mysite.dnndev.me.");
                    Info("  --install-folder <path>   Required. Website, Logs and Database folders are created here.");
                    Info("  --package <id>            Package to install. Defaults to the newest available package.");
                    Info("  --version <version>       Package version. Defaults to the newest version of the package.");
                    Info("  --local-package <path>    Install from a local DNN install zip instead of downloading.");
                    Info("  --include-prereleases     Allow release candidate packages to be selected.");
                    Info($"  --db-server <name>        Database server. Defaults to {DefaultDatabaseServer}.");
                    Info("  --db-name <name>          Database name. Defaults to the site name up to the first dot.");
                    Info("  --db-user <user>          SQL Server login. Windows authentication is used when omitted.");
                    Info("  --db-password <password>  SQL Server password. Required with --db-user.");
                    Info("  --skip-db                 Do not create the database or set permissions; the db options only shape web.config.");
                    Info("  --no-app-pool             Use DefaultAppPool instead of a site specific application pool.");
                    Info("  --ssl                     Add an https binding.");
                    Info("  --certificate <name>      Certificate friendly name or thumbprint. Defaults to the first one found.");
                    Info("  --delete-existing-site    Replace an existing IIS site with the same name.");
                    Info("  --force                   Overwrite a non-empty install folder and re-download the package.");
                    break;
                case "list":
                    Info("Usage: nvQuickSite --cli list [--all]");
                    Info(string.Empty);
                    Info("  --all   Include sites that were not created by nvQuickSite.");
                    break;
                case "delete":
                case "remove":
                    Info("Usage: nvQuickSite --cli delete --site <name> --yes [options]");
                    Info(string.Empty);
                    Info("  --site <name>             Required. The site to delete, as shown by the list command.");
                    Info("  --yes                     Required. Confirms this destructive operation.");
                    Info("  --db-server <name>        Database server. Defaults to the last one used by the wizard.");
                    Info("  --db-name <name>          Database name. Defaults to the site name up to the first dot.");
                    Info("  --db-user <user>          SQL Server login. Windows authentication is used when omitted.");
                    Info("  --db-password <password>  SQL Server password. Required with --db-user.");
                    break;
                case "packages":
                    Info("Usage: nvQuickSite --cli packages [--include-prereleases]");
                    break;
                default:
                    Info("nvQuickSite installs DNN Platform sites on a local IIS and SQL Server.");
                    Info(string.Empty);
                    Info("Usage: nvQuickSite --cli <command> [options]");
                    Info(string.Empty);
                    Info("  install    Install a new DNN site.");
                    Info("  list       List the sites created by nvQuickSite.");
                    Info("  delete     Delete a site created by nvQuickSite.");
                    Info("  packages   List the DNN packages available to install.");
                    Info(string.Empty);
                    Info("Any command accepts --verbose to log debug information to the console.");
                    Info(string.Empty);
                    Info("Run 'nvQuickSite --cli <command> --help' for the options of a command.");
                    Info("Run nvQuickSite without --cli to start the wizard.");
                    Info("Both modes require an elevated command prompt.");
                    break;
            }
        }

        /// <summary>
        /// A site read out of IIS, detached from the <see cref="ServerManager"/> that produced it.
        /// </summary>
        private class SiteInfo
        {
            public long Id { get; set; }

            public string Name { get; set; }

            public string ApplicationPool { get; set; }

            public string State { get; set; }

            public string PhysicalPath { get; set; }
        }

        /// <summary>
        /// Signals a problem with the command line itself rather than with the work it asked for.
        /// </summary>
        private class UsageException : Exception
        {
            public UsageException(string message)
                : base(message)
            {
            }
        }

        /// <summary>
        /// Parses <c>--name value</c> options and <c>--name</c> flags.
        /// </summary>
        private class Options
        {
            private readonly Dictionary<string, string> values =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            private readonly HashSet<string> flags =
                new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            public Options(string[] args)
            {
                for (var i = 0; i < args.Length; i++)
                {
                    if (!args[i].StartsWith("-", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    var name = args[i].TrimStart('-');
                    var equals = name.IndexOf('=');
                    if (equals >= 0)
                    {
                        this.values[name.Substring(0, equals)] = name.Substring(equals + 1);
                        continue;
                    }

                    if (i + 1 < args.Length && !args[i + 1].StartsWith("-", StringComparison.Ordinal))
                    {
                        this.values[name] = args[++i];
                    }
                    else
                    {
                        this.flags.Add(name);
                    }
                }
            }

            public bool HasFlag(string name)
            {
                return this.flags.Contains(name);
            }

            public string Get(string name, string defaultValue)
            {
                string value;
                return this.values.TryGetValue(name, out value) ? value : defaultValue;
            }

            public string Require(string name)
            {
                var value = this.Get(name, null);
                if (string.IsNullOrWhiteSpace(value))
                {
                    throw new UsageException($"--{name} is required.");
                }

                return value;
            }
        }
    }
}
