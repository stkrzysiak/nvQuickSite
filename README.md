[![nvQuickSite Logo](https://www.nvquicksite.com/Portals/0/nvQuickSite_LOGO_final_yellow.png)](https://www.nvquicksite.com)

nvQuickSite is a desktop installation app for DNN, the world's most popular ASP.NET-based CMS.  This app allows you to easily install DNN onto any environment that meets [the minimum system requirements for DNN to be installed](https://github.com/nvisionative/nvQuickSite/wiki/Minimum-System-Requirements).

![Installation Complete](https://www.nvquicksite.com/Portals/0/adam/Basic%20Content/gjzknonSxESiQva1cwsOfg/Image/nvQuickSite_2.0.0_Progress_Complete.jpg)

## Why Use nvQuickSite?

**Designers & End Users**

This app isn't just for the developers out there. If you test DNN or want to just get a DNN site up and running, just ask your developer friend(s) to get the prerequisites installed and configured. After that, everything you need to know and do is a few simple clicks away.

**Developers**

Even the most seasoned of ASP.NET developers require several minutes to follow the minimum steps necessary to install any web application. This process is time-consuming and error-prone.  This wizard-based app turns that into a couple of moments, without requiring you to open any additional apps.  Use it once, and you'll never again install DNN manually.

## Background
There's been many ways to install DNN over the years, but a cult favorite of many in the community has been and continued to be *MakeDNNSite*, written by Mike van der Muelen.  Unfortunately, Mike has since moved on to other things, and work on his installer had been discontinued. David Poindexter and the [nvisionative](http://www.nvisionative.com) team took this as an opportunity to build a new installer for all of the DNN community to use.  If you liked MakeDNNSite yourself, you'll love nvQuickSite. It has everything good that MakeDNNSite had, and none of the bad.

## Command Line

`nvQuickSite.exe --cli` runs the same installation steps as the wizard without opening a window, so a site can be created from a script or a build step. It needs an elevated command prompt, because it writes to IIS, SQL Server and the hosts file.

```
nvQuickSite.exe --cli install --site mysite.dnndev.me --install-folder C:\websites\mysite
nvQuickSite.exe --cli install --site mysite.dnndev.me --install-folder C:\websites\mysite ^
    --package dnn-platform-9 --version 9.13.4 --db-server "(local)" --db-name mysite --ssl
nvQuickSite.exe --cli packages
nvQuickSite.exe --cli list
nvQuickSite.exe --cli delete --site mysite.dnndev.me --yes
```

Windows authentication is used for SQL Server unless `--db-user` and `--db-password` are given. The install folder must be empty unless `--force` is passed, and an existing IIS site of the same name is only replaced with `--delete-existing-site`. Run `nvQuickSite.exe --cli install --help` for the full option list, and add `--verbose` to any command for debug logging.

The exit code is 0 on success, 1 when a step fails, and 2 when the command line is wrong. Because nvQuickSite is a Windows application rather than a console one, `cmd.exe` returns its prompt before the output finishes; use `start /wait nvQuickSite.exe --cli ...` in scripts that need to wait for the exit code.

## Wiki Pages
* [Home](https://github.com/nvisionative/nvQuickSite/wiki)
* [Install & Uninstall nvQuickSite](https://github.com/nvisionative/nvQuickSite/wiki/Install-&-Uninstall-nvQuickSite)
* [Create a DNN Site](https://github.com/nvisionative/nvQuickSite/wiki/Create-a-DNN-Site)
* [Minimum System Requirements](https://github.com/nvisionative/nvQuickSite/wiki/Minimum-System-Requirements)
* [nvQuickSite Footers](https://github.com/nvisionative/nvQuickSite/wiki/nvQuickSite-Footers)
 
---
[![Brought to the DNN community by nvisionative](http://www.nvquicksite.com/Portals/0/broughtBy-nvisionative.png)](http://www.nvisionative.com)
