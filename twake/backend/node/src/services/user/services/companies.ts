import _, { merge } from "lodash";

import {
  CrudException,
  DeleteResult,
  ExecutionContext,
  ListResult,
  OperationType,
  Pagination,
  SaveResult,
} from "../../../core/platform/framework/api/crud-service";
import Repository, {
  FindOptions,
} from "../../../core/platform/services/database/services/orm/repository/repository";
import { UserPrimaryKey } from "../entities/user";
import { CompaniesServiceAPI } from "../api";
import Company, {
  CompanyPrimaryKey,
  CompanySearchKey,
  getInstance as getCompanyInstance,
} from "../entities/company";
import CompanyUser, {
  CompanyUserPrimaryKey,
  getInstance as getCompanyUserInstance,
} from "../entities/company_user";
import { ListUserOptions } from "./users/types";
import { CompanyUserRole } from "../web/types";
import { ResourceEventsPayload, uuid } from "../../../utils/types";
import ExternalGroup, {
  ExternalGroupPrimaryKey,
  getInstance as getExternalGroupInstance,
} from "../entities/external_company";
import { logger, RealtimeSaved } from "../../../core/platform/framework";
import { getCompanyRoom, getUserRoom } from "../realtime";
import gr from "../../global-resolver";
import { localEventBus } from "../../../core/platform/framework/pubsub";
import {
  KnowledgeGraphGenericEventPayload,
  KnowledgeGraphEvents,
} from "../../../core/platform/services/knowledge-graph/types";

export class CompanyServiceImpl implements CompaniesServiceAPI {
  version: "1";
  companyRepository: Repository<Company>;
  externalCompanyRepository: Repository<ExternalGroup>;
  companyUserRepository: Repository<CompanyUser>;

  async init(): Promise<this> {
    this.companyRepository = await gr.database.getRepository<Company>("group_entity", Company);
    this.companyUserRepository = await gr.database.getRepository<CompanyUser>(
      "group_user",
      CompanyUser,
    );
    this.externalCompanyRepository = await gr.database.getRepository<ExternalGroup>(
      "external_group_repository",
      ExternalGroup,
    );

    return this;
  }

  private getExtCompany(pk: ExternalGroupPrimaryKey) {
    return this.externalCompanyRepository.findOne(pk);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  @RealtimeSaved<Company>((company, _context) => {
    return [
      {
        room: getCompanyRoom(company.id),
        resource: company,
      },
    ];
  })
  async updateCompany<SaveOptions>(
    company: Company,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options?: SaveOptions,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _context?: ExecutionContext,
  ): Promise<SaveResult<Company>> {
    if (company.identity_provider_id && !company.identity_provider) {
      company.identity_provider = "console";
    }

    await this.companyRepository.save(company);

    if (company.identity_provider_id) {
      const key = {
        service_id: company.identity_provider,
        external_id: company.identity_provider_id,
      };

      const extCompany = (await this.getExtCompany(key)) || getExternalGroupInstance(key);

      extCompany.company_id = company.id;
      extCompany.external_id = company.identity_provider_id;
      extCompany.service_id = company.identity_provider;

      await this.externalCompanyRepository.save(extCompany);
    }

    return new SaveResult<Company>("company", company, OperationType.UPDATE);
  }

  async createCompany(company: Company): Promise<Company> {
    const companyToCreate: Company = getCompanyInstance({
      ...company,
      ...{
        dateAdded: Date.now(),
      },
    });

    const result = await this.updateCompany(companyToCreate);

    localEventBus.publish<KnowledgeGraphGenericEventPayload<Company>>(
      KnowledgeGraphEvents.COMPANY_CREATED,
      {
        id: result.entity.id,
        resource: result.entity,
        links: [{ relation: "owner", type: "user", id: result.context?.user.id }],
      },
    );
    return result.entity;
  }

  async getCompany(companySearchKey: CompanySearchKey): Promise<Company> {
    if (companySearchKey.id) {
      return this.companyRepository.findOne(companySearchKey);
    } else if (companySearchKey.identity_provider_id) {
      const extCompany = await this.getExtCompany({
        external_id: companySearchKey.identity_provider_id,
        service_id: companySearchKey.identity_provider || "console",
      });
      if (!extCompany) {
        return null;
      }
      return await this.companyRepository.findOne({ id: extCompany.company_id });
    }
  }

  async getCompanyUser(company: CompanyPrimaryKey, user: UserPrimaryKey): Promise<CompanyUser> {
    const companyUser = await this.companyUserRepository.findOne({
      group_id: company.id,
      user_id: user.id,
    });
    if (companyUser) companyUser.applications = [];
    return companyUser;
  }

  async getAllForUser(userId: uuid): Promise<CompanyUser[]> {
    const list = await this.companyUserRepository
      .find({ user_id: userId })
      .then(a => a.getEntities());

    // Update user cache with companies
    const user = await gr.services.users.get({ id: userId });
    if (
      user.cache?.companies.length === 0 ||
      _.difference(
        list.map(c => c.group_id),
        user.cache?.companies || [],
      ).length != 0
    ) {
      if (!user.cache) user.cache = { companies: [] };
      user.cache.companies = list.map(c => c.group_id);
      await gr.services.users.save(user, {}, { user: { id: user.id, server_request: true } });
    }

    return list;
  }

  getCompanies(pagination?: Pagination): Promise<ListResult<Company>> {
    return this.companyRepository.find({}, { pagination });
  }

  @RealtimeSaved<CompanyUser>((companyUser, _) => {
    return [
      {
        room: getUserRoom(companyUser?.user_id),
        resource: companyUser,
      },
    ];
  })
  async removeUserFromCompany(
    companyPk: CompanyPrimaryKey,
    userPk: UserPrimaryKey,
  ): Promise<DeleteResult<CompanyUser>> {
    const entity = await this.companyUserRepository.findOne({
      group_id: companyPk.id,
      user_id: userPk.id,
    });
    if (entity) {
      await Promise.all([this.companyUserRepository.remove(entity)]);

      const user = await gr.services.users.get(userPk);
      if ((user.cache?.companies || []).includes(companyPk.id)) {
        // Update user cache with companies
        user.cache.companies = user.cache.companies.filter(id => id != companyPk.id);
        await gr.services.users.save(user, {}, { user: { id: user.id, server_request: true } });
      }

      localEventBus.publish<ResourceEventsPayload>("company:user:deleted", {
        user: user,
        company: companyPk,
      });
    }

    return new DeleteResult("company_user", entity, true);
  }

  async getUsers(
    companyId: CompanyUserPrimaryKey,
    pagination?: Pagination,
    options?: ListUserOptions,
  ): Promise<ListResult<CompanyUser>> {
    const findOptions: FindOptions = {
      pagination,
    };

    if (options?.userIds) {
      findOptions.$in = [["user_id", options.userIds]];
    }

    return this.companyUserRepository.find({ group_id: companyId.group_id }, findOptions);
  }

  async delete(pk: CompanyPrimaryKey, context?: ExecutionContext): Promise<DeleteResult<Company>> {
    const instance = await this.companyRepository.findOne(pk);
    if (instance) await this.companyRepository.remove(instance);
    return new DeleteResult<Company>("company", instance, !!instance);
  }

  @RealtimeSaved<CompanyUser>((companyUser, _) => {
    return [
      {
        room: getUserRoom(companyUser?.user_id),
        resource: companyUser,
      },
    ];
  })
  async setUserRole(
    companyId: uuid,
    userId: uuid,
    role: CompanyUserRole = "member",
    applications: string[] = [],
  ): Promise<SaveResult<CompanyUser>> {
    const key = {
      group_id: companyId,
      user_id: userId,
    };
    let entity = await this.companyUserRepository.findOne(key);

    if (entity == null) {
      entity = getCompanyUserInstance(merge(key, { dateAdded: Date.now() }));
    }

    entity.role = role;
    entity.applications = applications;
    await this.companyUserRepository.save(entity);

    const user = await gr.services.users.get({ id: userId });
    if (!(user.cache?.companies || []).includes(companyId)) {
      // Update user cache with companies
      if (!user.cache) user.cache = { companies: [] };
      user.cache.companies.push(companyId);
      await gr.services.users.save(user, {}, { user: { id: user.id, server_request: true } });
    }

    return new SaveResult("company_user", entity, OperationType.UPDATE);
  }

  async removeCompany(searchKey: CompanySearchKey): Promise<void> {
    if (searchKey.identity_provider_id) {
      const extCompany = await this.getExtCompany({
        service_id: searchKey.identity_provider,
        external_id: searchKey.identity_provider_id,
      });
      if (!extCompany) {
        throw CrudException.notFound(`Company ${searchKey.identity_provider_id} not found`);
      }
      await this.externalCompanyRepository.remove(extCompany);
      searchKey.id = extCompany.company_id;
    }

    const company = await this.getCompany({ id: searchKey.id });
    if (!company) {
      throw CrudException.notFound(`Company ${searchKey.id} not found`);
    }

    await this.companyRepository.remove(company);

    return Promise.resolve(null);
  }

  getUsersCount(companyId: string): Promise<number> {
    return this.getCompany({ id: companyId }).then(a => a.memberCount);
  }

  async getUserRole(companyId: uuid, userId: uuid): Promise<CompanyUserRole> {
    const companyUser = await this.getCompanyUser({ id: companyId }, { id: userId });
    if (!companyUser) {
      return "guest";
    }
    return companyUser.role;
  }

  async ensureDeletedUserNotInCompanies(userPk: UserPrimaryKey) {
    const user = await gr.services.users.get(userPk);
    if (user.deleted) {
      const companies = await this.getAllForUser(user.id);
      for (const company of companies) {
        logger.warn(`User ${userPk.id} is deleted so removed from company ${company.id}`);
        await this.removeUserFromCompany(company, user);
        await gr.services.workspaces.ensureUserNotInCompanyIsNotInWorkspace(userPk, company.id);
      }
    }
  }
}
